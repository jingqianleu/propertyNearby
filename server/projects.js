import { query } from './db.js';

const STATUS_LABELS = new Map([
  ['0', 'Belum Mula'],
  ['1', 'Lancar'],
  ['2', 'Sakit'],
  ['3', 'Lewat'],
  ['5', 'Siap Dengan CCC'],
  ['7', 'Siap Dengan CFO'],
  ['B', 'Permit Telah Dibatalkan'],
]);

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function displayDate(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(value));
}

function publicProject(row, components = undefined) {
  const project = {
    id: row.id,
    name: row.name,
    phase: row.phase,
    developer: { code: row.developer_code, name: row.developer_name },
    location: {
      latitude: finiteNumber(row.latitude),
      longitude: finiteNumber(row.longitude),
      state_id: row.state_id,
      state: row.state_name,
      district_id: row.district_id,
      district: row.district_name,
      city_id: row.city_id,
      city: row.city_name,
      postcode: row.postcode,
    },
    status: { code: row.status_code, label: row.status_label || STATUS_LABELS.get(row.status_code) || null },
    permit: {
      id: row.permit_id,
      number: row.permit_number,
      start_date: dateOnly(row.permit_start),
      expiry_date: dateOnly(row.permit_expiry),
      expiry_display: displayDate(row.permit_expiry),
      cancelled: row.permit_cancelled,
    },
    price: {
      minimum: finiteNumber(row.price_min),
      maximum: finiteNumber(row.price_max),
      currency: 'MYR',
    },
    source: {
      name: 'TEDUH',
      version: row.source_version,
      updated_at: row.source_updated_at,
      detail_synced_at: row.detail_synced_at,
    },
  };
  if (components !== undefined) project.components = components;
  return project;
}

function addCondition(conditions, values, expression, value) {
  values.push(value);
  conditions.push(expression.replace('?', `$${values.length}`));
}

export async function listProjects(searchParams) {
  const page = positiveInteger(searchParams.get('page'), 1, 100_000);
  const perPage = positiveInteger(searchParams.get('per_page'), 50, 100);
  const conditions = ['p.is_active = true'];
  const values = [];
  const q = String(searchParams.get('q') || '').trim().slice(0, 200);
  const searchType = searchParams.get('search_type');

  if (q) {
    addCondition(
      conditions,
      values,
      searchType === 'pemaju' || searchType === 'developer'
        ? 'p.developer_name ILIKE ?'
        : 'p.name ILIKE ?',
      `%${q}%`,
    );
  }

  const exactFilters = [
    ['state', 'p.state_id'],
    ['district', 'p.district_id'],
    ['city', 'p.city_id'],
    ['statusProjek', 'p.status_code'],
    ['status', 'p.status_code'],
  ];
  const usedColumns = new Set();
  for (const [parameter, column] of exactFilters) {
    const value = searchParams.get(parameter);
    if (value && !usedColumns.has(column)) {
      addCondition(conditions, values, `${column} = ?`, value);
      usedColumns.add(column);
    }
  }

  const permitYear = Number.parseInt(searchParams.get('permit_expiry_year'), 10);
  if (Number.isInteger(permitYear) && permitYear >= 1900 && permitYear <= 2200) {
    addCondition(conditions, values, 'EXTRACT(YEAR FROM p.permit_expiry) = ?', permitYear);
  }

  const minimumPrice = finiteNumber(searchParams.get('pricemin') || searchParams.get('price_min'));
  const maximumPrice = finiteNumber(searchParams.get('pricemax') || searchParams.get('price_max'));
  if (minimumPrice !== null) {
    addCondition(conditions, values, 'COALESCE(p.price_max, p.price_min) >= ?', minimumPrice);
  }
  if (maximumPrice !== null) {
    addCondition(conditions, values, 'COALESCE(p.price_min, p.price_max) <= ?', maximumPrice);
  }

  const latitude = finiteNumber(searchParams.get('lat'));
  const longitude = finiteNumber(searchParams.get('lng'));
  const radiusKm = finiteNumber(searchParams.get('radius_km'));
  let distanceExpression = 'NULL::double precision AS distance_metres';
  let orderBy = 'p.name ASC, p.id ASC';
  let pointExpression = null;
  if (latitude !== null && longitude !== null) {
    if (radiusKm !== null && radiusKm > 0) {
      values.push(longitude, latitude);
      pointExpression = `ST_SetSRID(ST_MakePoint($${values.length - 1}, $${values.length}), 4326)::geography`;
      values.push(radiusKm * 1000);
      conditions.push(`ST_DWithin(p.location, ${pointExpression}, $${values.length})`);
    }
  }

  const where = conditions.join(' AND ');
  const countValues = [...values];
  const countSql = `SELECT count(*)::integer AS total FROM projects p WHERE ${where}`;
  if (latitude !== null && longitude !== null) {
    if (!pointExpression) {
      values.push(longitude, latitude);
      pointExpression = `ST_SetSRID(ST_MakePoint($${values.length - 1}, $${values.length}), 4326)::geography`;
    }
    distanceExpression = `ST_Distance(p.location, ${pointExpression}) AS distance_metres`;
    orderBy = 'distance_metres ASC NULLS LAST, p.name ASC';
  }
  values.push(perPage, (page - 1) * perPage);

  const listSql = `
    SELECT p.*, s.name AS state_name, d.name AS district_name, c.name AS city_name,
           ${distanceExpression}
      FROM projects p
      LEFT JOIN states s ON s.id = p.state_id
      LEFT JOIN districts d ON d.id = p.district_id
      LEFT JOIN cities c ON c.id = p.city_id
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${values.length - 1} OFFSET $${values.length}`;

  const [countResult, listResult, syncResult] = await Promise.all([
    query(countSql, countValues),
    query(listSql, values),
    query("SELECT finished_at FROM sync_runs WHERE status = 'succeeded' ORDER BY finished_at DESC LIMIT 1"),
  ]);
  const total = countResult.rows[0].total;

  return {
    data: listResult.rows.map(row => ({
      ...publicProject(row),
      distance_metres: finiteNumber(row.distance_metres),
    })),
    meta: {
      page,
      per_page: perPage,
      total,
      pages: Math.max(1, Math.ceil(total / perPage)),
      last_successful_sync: syncResult.rows[0]?.finished_at || null,
    },
  };
}

export async function getProject(projectId) {
  const [projectResult, componentsResult] = await Promise.all([
    query(`
      SELECT p.*, s.name AS state_name, d.name AS district_name, c.name AS city_name
        FROM projects p
        LEFT JOIN states s ON s.id = p.state_id
        LEFT JOIN districts d ON d.id = p.district_id
        LEFT JOIN cities c ON c.id = p.city_id
       WHERE p.id = $1 AND p.is_active = true`, [projectId]),
    query('SELECT * FROM project_components WHERE project_id = $1 ORDER BY component_index', [projectId]),
  ]);
  if (!projectResult.rowCount) return null;

  const components = componentsResult.rows.map(row => ({
    type: row.property_type,
    floors: row.floors,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    area: row.area,
    units: row.units,
    price_minimum: finiteNumber(row.price_min),
    price_maximum: finiteNumber(row.price_max),
    completion_percent: finiteNumber(row.completion_percent),
    status: row.status,
    ccc_date: dateOnly(row.ccc_date),
    vacant_possession_date: dateOnly(row.vacant_possession_date),
  }));
  return publicProject(projectResult.rows[0], components);
}

export async function listReference(type, parentId) {
  if (type === 'states') {
    const result = await query('SELECT id, name FROM states ORDER BY name');
    return result.rows;
  }
  if (type === 'districts') {
    const result = await query('SELECT id, state_id, name FROM districts WHERE state_id = $1 ORDER BY name', [parentId]);
    return result.rows;
  }
  if (type === 'cities') {
    const result = await query('SELECT id, state_id, district_id, name FROM cities WHERE district_id = $1 ORDER BY name', [parentId]);
    return result.rows;
  }
  if (type === 'statuses') {
    return [...STATUS_LABELS].map(([id, name]) => ({ id, name }));
  }
  return [];
}
