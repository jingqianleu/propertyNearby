import { createHash } from 'node:crypto';
import { pool, withTransaction } from '../server/db.js';

const apiBase = process.env.TEDUH_API_BASE || 'https://teduh.kpkt.gov.my/api';
const pageSize = 20;
const detailConcurrency = Math.max(1, Math.min(Number(process.env.TEDUH_DETAIL_CONCURRENCY || 3), 8));
const requestDelay = Math.max(0, Number(process.env.TEDUH_REQUEST_DELAY_MS || 150));
const lockName = 'property-nearby-teduh-sync';
const stateIds = Array.from({ length: 16 }, (_, index) => String(index + 1).padStart(2, '0'));

function argumentNumber(name) {
  const argument = process.argv.find(value => value.startsWith(`--${name}=`));
  return argument ? Math.max(0, Number(argument.split('=')[1]) || 0) : null;
}

function argumentText(name) {
  const argument = process.argv.find(value => value.startsWith(`--${name}=`));
  return argument ? argument.slice(name.length + 3).trim() : null;
}

const maxPages = argumentNumber('max-pages');
const detailLimit = argumentNumber('detail-limit');
const forceDetails = process.argv.includes('--force-details');
const requestedState = argumentText('state');
const statesToSync = requestedState ? [requestedState.padStart(2, '0')] : stateIds;

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'PropertyNearby/1.0 TEDUH daily sync' },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) return await response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      const retryAfter = Number(response.headers.get('retry-after'));
      await wait(Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 15_000));
      lastError = Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, attempt });
    } catch (error) {
      lastError = Object.assign(error, { attempt });
      if (attempt < 5) await wait(Math.min(1000 * 2 ** attempt, 15_000));
    }
  }
  throw lastError;
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicSummary(project) {
  return {
    ...project,
    pemaju: project.pemaju ? {
      kod_pemaju: project.pemaju.kod_pemaju,
      nama: project.pemaju.nama,
      no_ssm: project.pemaju.no_ssm,
      status_syarikat: project.pemaju.status_syarikat,
      version: project.pemaju.version,
      updated_at: project.pemaju.updated_at,
    } : null,
  };
}

function changeFingerprint(project) {
  return {
    id: project.id,
    version: project.version,
    updated_at: project.updated_at,
    name: project.nama,
    phase: project.nama_fasa,
    state: project.kod_negeri_id,
    district: project.kod_daerah_id,
    city: project.kod_bandar_id,
    postcode: project.poskod,
    latitude: project.latitud,
    longitude: project.longitud,
    status: project.status_projek,
    status_label: project.status_project?.keterangan,
    developer: {
      code: project.pemaju?.kod_pemaju,
      name: project.pemaju?.nama,
      version: project.pemaju?.version,
      updated_at: project.pemaju?.updated_at,
    },
    permit: project.latest_lesen ? {
      id: project.latest_lesen.id,
      number: project.latest_lesen.no_lesenpermit,
      start: project.latest_lesen.tarikh_mula,
      expiry: project.latest_lesen.tarikh_luput,
      cancelled: project.latest_lesen.batal_lesen,
      active: project.latest_lesen.lesen_aktif,
      version: project.latest_lesen.version,
      updated_at: project.latest_lesen.updated_at,
    } : null,
  };
}

function storedDetail(detail) {
  return {
    id: detail.id,
    name: detail.nama,
    status: detail.status ? {
      overall: detail.status.keseluruhan,
      development: detail.status.maklumatPembangunan,
      note: detail.status.nota,
      rows: detail.status.rows,
    } : null,
    unit_summary: detail.unitSummary,
  };
}

function decimal(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function dateOnly(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function validCoordinates(project) {
  if (project.latitud === null || project.latitud === undefined || project.longitud === null || project.longitud === undefined) return false;
  const latitude = Number(project.latitud);
  const longitude = Number(project.longitud);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

async function mapConcurrent(items, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await operation(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function syncReferences() {
  console.log('Refreshing district and city reference data…');
  for (const stateId of statesToSync) {
    const districts = await fetchJson(`${apiBase}/daerah-by-negeri?${new URLSearchParams({ negeri_id: stateId })}`);
    for (const district of districts) {
      await pool.query(`
        INSERT INTO districts (id, state_id, name, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (id) DO UPDATE SET state_id = EXCLUDED.state_id, name = EXCLUDED.name, updated_at = now()`,
      [district.id, district.kod_negeri_id || stateId, district.keterangan]);
      const cities = await fetchJson(`${apiBase}/bandar-by-daerah?${new URLSearchParams({ daerah_id: district.id })}`);
      for (const city of cities) {
        await pool.query(`
          INSERT INTO cities (id, district_id, state_id, name, updated_at)
          VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (id) DO UPDATE SET district_id = EXCLUDED.district_id, state_id = EXCLUDED.state_id,
            name = EXCLUDED.name, updated_at = now()`,
        [city.id, city.kod_daerah_id || district.id, city.kod_negeri_id || stateId, city.keterangan]);
      }
      if (requestDelay) await wait(requestDelay);
    }
  }
}

async function ensureReferences(client, project) {
  if (project.kod_daerah_id && project.kod_negeri_id) {
    await client.query(`
      INSERT INTO districts (id, state_id, name) VALUES ($1, $2, $1)
      ON CONFLICT (id) DO NOTHING`, [project.kod_daerah_id, project.kod_negeri_id]);
  }
  if (project.kod_bandar_id && project.kod_daerah_id && project.kod_negeri_id) {
    await client.query(`
      INSERT INTO cities (id, district_id, state_id, name) VALUES ($1, $2, $3, $1)
      ON CONFLICT (id) DO NOTHING`, [project.kod_bandar_id, project.kod_daerah_id, project.kod_negeri_id]);
  }
}

async function upsertSummary(project, sourceHash, runId, seenAt) {
  const permit = project.latest_lesen || {};
  const coordinatesAreValid = validCoordinates(project);
  await withTransaction(async client => {
    await ensureReferences(client, project);
    await client.query(`
      INSERT INTO projects (
        id, dim_id, developer_code, developer_name, name, phase, state_id, district_id, city_id,
        postcode, parliament_id, pbt_id, status_code, status_label, latitude, longitude, location,
        permit_id, permit_number, permit_start, permit_expiry, permit_cancelled, source_version,
        source_updated_at, source_hash, raw_summary, last_seen_at, is_active, last_sync_run_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        CASE WHEN $15::double precision IS NULL OR $16::double precision IS NULL THEN NULL
          ELSE ST_SetSRID(ST_MakePoint($16, $15), 4326)::geography END,
        $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26, true, $27
      )
      ON CONFLICT (id) DO UPDATE SET
        dim_id = EXCLUDED.dim_id, developer_code = EXCLUDED.developer_code,
        developer_name = EXCLUDED.developer_name, name = EXCLUDED.name, phase = EXCLUDED.phase,
        state_id = EXCLUDED.state_id, district_id = EXCLUDED.district_id, city_id = EXCLUDED.city_id,
        postcode = EXCLUDED.postcode, parliament_id = EXCLUDED.parliament_id, pbt_id = EXCLUDED.pbt_id,
        status_code = EXCLUDED.status_code, status_label = EXCLUDED.status_label,
        latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, location = EXCLUDED.location,
        permit_id = EXCLUDED.permit_id, permit_number = EXCLUDED.permit_number,
        permit_start = EXCLUDED.permit_start, permit_expiry = EXCLUDED.permit_expiry,
        permit_cancelled = EXCLUDED.permit_cancelled, source_version = EXCLUDED.source_version,
        source_updated_at = EXCLUDED.source_updated_at, source_hash = EXCLUDED.source_hash,
        raw_summary = EXCLUDED.raw_summary, last_seen_at = EXCLUDED.last_seen_at,
        is_active = true, last_sync_run_id = EXCLUDED.last_sync_run_id`, [
      project.id,
      project.dim_id,
      project.kod_pemaju,
      project.pemaju?.nama || null,
      project.nama || project.id,
      project.nama_fasa || (project.kod_fasa == null ? null : String(project.kod_fasa)),
      project.kod_negeri_id || null,
      project.kod_daerah_id || null,
      project.kod_bandar_id || null,
      project.poskod || null,
      project.kod_parlimen_id || null,
      project.kod_pbt_id || null,
      project.status_projek || project.status_project?.id || null,
      project.status_project?.keterangan || null,
      coordinatesAreValid ? Number(project.latitud) : null,
      coordinatesAreValid ? Number(project.longitud) : null,
      permit.id || null,
      permit.no_lesenpermit || null,
      dateOnly(permit.tarikh_mula),
      dateOnly(permit.tarikh_luput),
      permit.batal_lesen === 'Y',
      integer(project.version),
      project.updated_at || null,
      sourceHash,
      JSON.stringify(publicSummary(project)),
      seenAt,
      runId,
    ]);
  });
}

async function syncDetail(project, runId) {
  const url = `${apiBase}/projek-swasta/${encodeURIComponent(project.id)}`;
  const detail = await fetchJson(url);
  const rows = Array.isArray(detail.status?.rows) ? detail.status.rows : [];
  const prices = rows.flatMap(row => [decimal(row.hargaMin), decimal(row.hargaMax)]).filter(value => value !== null);
  const minimum = prices.length ? Math.min(...prices) : null;
  const maximum = prices.length ? Math.max(...prices) : null;

  await withTransaction(async client => {
    await client.query('DELETE FROM project_components WHERE project_id = $1', [project.id]);
    for (const [index, row] of rows.entries()) {
      await client.query(`
        INSERT INTO project_components (
          project_id, component_index, property_type, floors, bedrooms, bathrooms, area, units,
          price_min, price_max, completion_percent, status, ccc_date, vacant_possession_date, raw_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`, [
        project.id, index, row.jenis || null, row.tingkat || null, row.bilik || null,
        row.tandas || null, row.keluasan || null, integer(row.unit), decimal(row.hargaMin),
        decimal(row.hargaMax), decimal(row.peratus), row.komponen || null, dateOnly(row.ccc),
        dateOnly(row.vp), JSON.stringify(row),
      ]);
    }
    await client.query(`
      UPDATE projects SET price_min = $2, price_max = $3, raw_detail = $4::jsonb,
        detail_synced_at = now(), last_sync_run_id = $5
      WHERE id = $1`, [project.id, minimum, maximum, JSON.stringify(storedDetail(detail)), runId]);
  });
}

async function recordSyncError(runId, projectId, requestUrl, error) {
  await pool.query(`
    INSERT INTO sync_errors (sync_run_id, project_id, request_url, http_status, attempt, message)
    VALUES ($1, $2, $3, $4, $5, $6)`, [
    runId, projectId, requestUrl, error.status || null, error.attempt || null, String(error.message || error).slice(0, 2000),
  ]);
}

async function runSync() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure it.');
  const lockClient = await pool.connect();
  let runId;
  const seenAt = new Date();
  let pagesFetched = 0;
  let projectsSeen = 0;
  let projectsChanged = 0;
  let detailsFetched = 0;
  let errorsCount = 0;
  let expectedProjects = 0;

  try {
    const lock = await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [lockName]);
    if (!lock.rows[0].acquired) {
      console.log('Another TEDUH synchronization is already running; exiting safely.');
      return;
    }
    const run = await lockClient.query(`
      INSERT INTO sync_runs (status, metadata) VALUES ('running', $1::jsonb) RETURNING id`, [
      JSON.stringify({ state: requestedState, max_pages: maxPages, detail_limit: detailLimit, force_details: forceDetails }),
    ]);
    runId = run.rows[0].id;

    await syncReferences();
    const detailQueue = [];

    for (const stateId of statesToSync) {
      if (maxPages && pagesFetched >= maxPages) break;
      const firstUrl = `${apiBase}/projek-swasta?${new URLSearchParams({ page: '1', per_page: String(pageSize), q: '', search_type: 'projek', state: stateId })}`;
      const firstResponse = await fetchJson(firstUrl);
      const stateLastPage = firstResponse.projects?.last_page || 1;
      expectedProjects += Number(firstResponse.projects?.total || 0);

      for (let page = 1; page <= stateLastPage; page += 1) {
        if (maxPages && pagesFetched >= maxPages) break;
        const response = page === 1 ? firstResponse : await fetchJson(`${apiBase}/projek-swasta?${new URLSearchParams({ page: String(page), per_page: String(pageSize), q: '', search_type: 'projek', state: stateId })}`);
        const pageProjects = response.projects?.data || [];
        const existingResult = await pool.query(
          'SELECT id, source_hash, detail_synced_at FROM projects WHERE id = ANY($1::text[])',
          [pageProjects.map(project => project.id)],
        );
        const existing = new Map(existingResult.rows.map(row => [row.id, row]));

        for (const project of pageProjects) {
          const sourceHash = stableHash(changeFingerprint(project));
          const previous = existing.get(project.id);
          const changed = forceDetails || !previous || previous.source_hash !== sourceHash || !previous.detail_synced_at;
          await upsertSummary(project, sourceHash, runId, seenAt);
          if (changed) detailQueue.push(project);
        }

        pagesFetched += 1;
        projectsSeen += pageProjects.length;
        console.log(`State ${stateId}: page ${page}/${stateLastPage}; total projects seen: ${projectsSeen}`);
        if (requestDelay) await wait(requestDelay);
      }
    }

    const detailsToFetch = detailLimit === null ? detailQueue : detailQueue.slice(0, detailLimit);
    projectsChanged = detailQueue.length;
    await mapConcurrent(detailsToFetch, detailConcurrency, async (project, index) => {
      const detailUrl = `${apiBase}/projek-swasta/${encodeURIComponent(project.id)}`;
      try {
        await syncDetail(project, runId);
        detailsFetched += 1;
      } catch (error) {
        errorsCount += 1;
        await recordSyncError(runId, project.id, detailUrl, error);
        console.error(`Detail failed for ${project.id}: ${error.message}`);
      }
      if ((index + 1) % 25 === 0 || index + 1 === detailsToFetch.length) {
        console.log(`Details: ${index + 1}/${detailsToFetch.length}`);
      }
      if (requestDelay) await wait(requestDelay);
    });

    const completeListRun = !maxPages && !requestedState;
    if (completeListRun) {
      if (projectsSeen < expectedProjects) {
        throw new Error(`Incomplete TEDUH list scan: expected ${expectedProjects} projects but received ${projectsSeen}.`);
      }
      await pool.query('UPDATE projects SET is_active = false WHERE is_active = true AND last_seen_at < $1', [seenAt]);
    }

    await lockClient.query(`
      UPDATE sync_runs SET status = 'succeeded', finished_at = now(), pages_fetched = $2,
        projects_seen = $3, projects_changed = $4, details_fetched = $5, errors_count = $6
      WHERE id = $1`, [runId, pagesFetched, projectsSeen, projectsChanged, detailsFetched, errorsCount]);
    console.log(`Sync complete: ${projectsSeen} summaries, ${detailsFetched} details, ${errorsCount} errors.`);
  } catch (error) {
    if (runId) {
      await lockClient.query(`
        UPDATE sync_runs SET status = 'failed', finished_at = now(), pages_fetched = $2,
          projects_seen = $3, projects_changed = $4, details_fetched = $5, errors_count = $6,
          error_message = $7 WHERE id = $1`, [
        runId, pagesFetched, projectsSeen, projectsChanged, detailsFetched, errorsCount,
        String(error.message || error).slice(0, 2000),
      ]);
    }
    throw error;
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
    } finally {
      lockClient.release();
    }
  }
}

try {
  await runSync();
} catch (error) {
  console.error('TEDUH synchronization failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
