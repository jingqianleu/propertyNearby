const applicationConfig = window.PROPERTY_NEARBY_CONFIG || {};
const API_BASE = String(applicationConfig.apiBaseUrl || '/api/v1').replace(/\/$/, '');
const API_ROOT = `${API_BASE}/projects`;
const DEFAULT_FILTERS = { q: '', search_type: 'projek', state: '', district: '', city: '', statusProjek: '', pricemin: '', pricemax: '' };
const MAX_PROJECTS = 2000;
const KEY_STORAGE = 'teduh-google-maps-key';

const elements = {
  map: document.querySelector('#map'), message: document.querySelector('#map-message'),
  list: document.querySelector('#project-list'),
  summary: document.querySelector('#summary'), count: document.querySelector('#count'),
  fit: document.querySelector('#fit-map'), locate: document.querySelector('#locate-me'),
  locationStatus: document.querySelector('#location-status'), dialog: document.querySelector('#key-dialog'),
  form: document.querySelector('#key-form'), key: document.querySelector('#maps-key'),
  error: document.querySelector('#key-error'), cancel: document.querySelector('#cancel-key'),
  filterForm: document.querySelector('#filter-form'), applyFilters: document.querySelector('#apply-filters'),
  resetFilters: document.querySelector('#reset-filters'), searchType: document.querySelector('#search-type'),
  keyword: document.querySelector('#keyword'), state: document.querySelector('#state'),
  district: document.querySelector('#district'), city: document.querySelector('#city'),
  projectStatus: document.querySelector('#project-status'), priceMin: document.querySelector('#price-min'),
  priceMax: document.querySelector('#price-max'), permitExpiryYear: document.querySelector('#permit-expiry-year'),
};

let map, infoWindow, projects = [], mappableProjects = [], markers = [], bounds;
let userLocationMarker = null;
let userAccuracyCircle = null;
let userInfoWindow = null;
let pendingUserLocation = null;
let locationWatchId = null;
let loadController = null;
let loadVersion = 0;

function apiUrl(page, filters) {
  const params = new URLSearchParams({ page: String(page), per_page: '100' });
  Object.entries(filters).forEach(([key, value]) => { if (value !== '') params.set(key, value); });
  return `${API_ROOT}?${params}`;
}

function showProgress(message) {
  elements.summary.textContent = message;
  if (elements.message?.isConnected) elements.message.textContent = message;
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithRetry(url, signal) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { signal });
    if (response.status !== 429 || attempt === 2) return response;
    const retryAfter = Number(response.headers.get('Retry-After'));
    await pause(Number.isFinite(retryAfter) ? retryAfter * 1000 : 750 * (attempt + 1), signal);
  }
}

async function fetchJson(url, signal) {
  const response = await fetchWithRetry(url, signal);
  if (!response.ok) throw new Error(`Property API returned ${response.status}.`);
  return response.json();
}

function validCoordinate(project) {
  const rawLatitude = project.location?.latitude;
  const rawLongitude = project.location?.longitude;
  if (rawLatitude === null || rawLatitude === undefined || rawLongitude === null || rawLongitude === undefined) return false;
  const lat = Number(rawLatitude); const lng = Number(rawLongitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function mapsLink(project) { return `https://www.google.com/maps/search/?api=1&query=${project.location.latitude},${project.location.longitude}`; }

function permitExpiry(project) {
  return project.permit?.expiry_display || project.permit?.expiry_date || 'Not published';
}

function parsePermitExpiry(project) {
  const value = project.permit?.expiry_date;
  if (!value) return null;
  const match = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function matchesPermitExpiry(project) {
  const selectedYear = Number(elements.permitExpiryYear.value);
  if (!selectedYear) return true;
  const expiry = parsePermitExpiry(project);
  return Boolean(expiry) && expiry.getFullYear() === selectedYear;
}

function formatPrice(value) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR', maximumFractionDigits: 0 }).format(value);
}

function projectPrice(project) {
  const rawMinimum = project.price?.minimum;
  const rawMaximum = project.price?.maximum;
  const minimum = Number(rawMinimum);
  const maximum = Number(rawMaximum);
  const hasMinimum = rawMinimum !== null && rawMinimum !== undefined && Number.isFinite(minimum);
  const hasMaximum = rawMaximum !== null && rawMaximum !== undefined && Number.isFinite(maximum);
  if (hasMinimum && hasMaximum) return `${formatPrice(minimum)} – ${formatPrice(maximum)}`;
  if (hasMinimum) return `From ${formatPrice(minimum)}`;
  if (hasMaximum) return `Up to ${formatPrice(maximum)}`;
  return 'Price not published';
}

async function fetchPage(page, filters, signal) {
  return fetchJson(apiUrl(page, filters), signal);
}

async function fetchEveryProject(filters, signal, version) {
  const first = await fetchPage(1, filters, signal);
  if (first.meta.total > MAX_PROJECTS) {
    throw new Error(`${first.meta.total.toLocaleString('en-MY')} projects match. Please narrow the filters to ${MAX_PROJECTS.toLocaleString('en-MY')} projects or fewer.`);
  }
  const pages = Array.from({ length: first.meta.pages - 1 }, (_, index) => index + 2);
  const rest = [];
  for (let index = 0; index < pages.length; index += 5) {
    const batch = await Promise.all(pages.slice(index, index + 5).map(page => fetchPage(page, filters, signal)));
    rest.push(...batch.flatMap(result => result.data));
    if (version === loadVersion) showProgress(`Loading matching projects… ${Math.min(index + 6, first.meta.pages)} of ${first.meta.pages} pages`);
  }
  return { projects: [...first.data, ...rest], total: first.meta.total, syncedAt: first.meta.last_successful_sync };
}

function replaceOptions(select, placeholder, items) {
  const selected = select.value;
  const options = [new Option(placeholder, ''), ...items.map(item => new Option(item.name, item.id))];
  select.replaceChildren(...options);
  if (options.some(option => option.value === selected)) select.value = selected;
  select.disabled = items.length === 0;
}

async function loadDistricts(stateId) {
  replaceOptions(elements.district, 'All districts', []);
  replaceOptions(elements.city, 'All cities', []);
  if (!stateId) return;
  const response = await fetchJson(`${API_BASE}/filters/districts?${new URLSearchParams({ state: stateId })}`);
  replaceOptions(elements.district, 'All districts', response.data);
}

async function loadCities(districtId) {
  replaceOptions(elements.city, 'All cities', []);
  if (!districtId) return;
  const response = await fetchJson(`${API_BASE}/filters/cities?${new URLSearchParams({ district: districtId })}`);
  replaceOptions(elements.city, 'All cities', response.data);
}

function selectedFilters() {
  return {
    search_type: elements.searchType.value,
    q: elements.keyword.value.trim(),
    state: elements.state.value,
    district: elements.district.value,
    city: elements.city.value,
    statusProjek: elements.projectStatus.value,
    pricemin: elements.priceMin.value,
    pricemax: elements.priceMax.value,
    permit_expiry_year: elements.permitExpiryYear.value,
  };
}

function updateMaximumPrices() {
  const minimum = Number(elements.priceMin.value || 0);
  Array.from(elements.priceMax.options).forEach(option => {
    option.disabled = Boolean(option.value) && Number(option.value) < minimum;
  });
  if (elements.priceMax.selectedOptions[0]?.disabled) elements.priceMax.value = '';
}

function markerContent(project) {
  const priceRows = (project.components || []).map(row => `<li>${escapeHtml(row.type || 'Unit')}: ${row.price_minimum == null ? '—' : escapeHtml(formatPrice(row.price_minimum))} – ${row.price_maximum == null ? '—' : escapeHtml(formatPrice(row.price_maximum))}</li>`).join('');
  const priceDetails = priceRows ? `<p><b>Component prices</b></p><ul>${priceRows}</ul>` : '';
  return `<div class="info-window"><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.developer?.name || 'Developer unavailable')}</p><p><b>Project ID:</b> ${escapeHtml(project.id)}</p><p><b>Status:</b> ${escapeHtml(project.status?.label || '—')}</p><p><b>Price:</b> ${escapeHtml(projectPrice(project))}</p>${priceDetails}<p><b>Tamat Sah Laku Permit Terkini:</b> ${escapeHtml(permitExpiry(project))}</p><p><b>Coordinates:</b> ${project.location.latitude}, ${project.location.longitude}</p><p><a target="_blank" rel="noopener" href="${mapsLink(project)}">Open in Google Maps</a></p></div>`;
}

function statusTone(project) {
  return ({ '0': 'pending', '1': 'smooth', '2': 'problem', '3': 'delayed', '5': 'complete', '7': 'complete', B: 'cancelled' })[project.status?.code] || 'neutral';
}

async function loadProjectDetail(project) {
  if (project.components || project.detailUnavailable) return project;
  try {
    const response = await fetchJson(`${API_ROOT}/${encodeURIComponent(project.id)}`);
    Object.assign(project, response.data);
  } catch {
    project.detailUnavailable = true;
  }
  return project;
}

async function focusProject(project) {
  if (!validCoordinate(project)) return;
  map.panTo({ lat: Number(project.location.latitude), lng: Number(project.location.longitude) });
  map.setZoom(16);
  const marker = markers.find(item => item.project.id === project.id)?.marker;
  if (marker) { infoWindow.setContent(markerContent(project)); infoWindow.open({ map, anchor: marker }); }
  document.querySelectorAll('.project').forEach(node => node.classList.toggle('active', node.dataset.id === project.id));
  await loadProjectDetail(project);
  if (marker) infoWindow.setContent(markerContent(project));
}

function renderList(items = projects) {
  elements.list.replaceChildren(...items.map(project => {
    const button = document.createElement('button');
    button.className = 'project'; button.dataset.id = project.id;
    const location = validCoordinate(project) ? `${project.location.latitude}, ${project.location.longitude}` : 'Exact coordinates unavailable';
    const projectStatus = project.status?.label || 'Status unavailable';
    button.innerHTML = `<span class="project-top"><strong>${escapeHtml(project.name)}</strong><span class="project-code">${escapeHtml(project.id)}</span></span><span class="developer">${escapeHtml(project.developer?.name || 'Developer unavailable')}</span><span class="project-meta"><span class="status status-${statusTone(project)}">${escapeHtml(projectStatus)}</span><span class="permit">Permit until ${escapeHtml(permitExpiry(project))}</span></span><span class="price">${escapeHtml(projectPrice(project))}</span><span class="location">${location}</span>`;
    button.addEventListener('click', () => focusProject(project));
    return button;
  }));
  elements.count.textContent = items.length;
}

function addMarkers() {
  markers.forEach(({ marker }) => marker.setMap(null));
  infoWindow?.close();
  bounds = new google.maps.LatLngBounds();
  infoWindow = new google.maps.InfoWindow();
  markers = mappableProjects.map(project => {
    const position = { lat: Number(project.location.latitude), lng: Number(project.location.longitude) };
    const marker = new google.maps.Marker({ map, position, title: project.name });
    marker.addListener('click', async () => {
      infoWindow.setContent(markerContent(project));
      infoWindow.open({ map, anchor: marker });
      await loadProjectDetail(project);
      infoWindow.setContent(markerContent(project));
    });
    bounds.extend(position); return { project, marker };
  });
  if (markers.length) map.fitBounds(bounds, 40);
  else { map.setCenter({ lat: 4.2105, lng: 101.9758 }); map.setZoom(6); }
}

function clearProjectResults() {
  loadController?.abort();
  loadVersion += 1;
  markers.forEach(({ marker }) => marker.setMap(null));
  infoWindow?.close();
  markers = [];
  projects = [];
  mappableProjects = [];
  renderList();
  elements.applyFilters.disabled = false;
  elements.fit.disabled = true;
  elements.summary.textContent = 'Choose your filters, then click Search projects.';
}

function showLocationStatus(message) {
  elements.locationStatus.textContent = message;
  elements.locationStatus.hidden = false;
}

function displayUserLocation(position) {
  const coordinates = `${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`;
  if (!map || !window.google?.maps) {
    pendingUserLocation = position;
    showLocationStatus(`Location found at ${coordinates}. Waiting for Google Maps to finish loading…`);
    return;
  }

  const currentPosition = { lat: position.coords.latitude, lng: position.coords.longitude };
  try {
    if (!userLocationMarker) {
      userLocationMarker = new google.maps.Marker({
        map,
        position: currentPosition,
        title: 'Your current location',
        zIndex: 10000,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#1479ff', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3 },
      });
      userInfoWindow = new google.maps.InfoWindow({ content: `<div class="info-window"><h3>Your current location</h3><p>${coordinates}</p><p>Location supplied by your browser.</p></div>` });
      userLocationMarker.addListener('click', () => userInfoWindow.open({ map, anchor: userLocationMarker }));
    } else {
      userLocationMarker.setPosition(currentPosition);
    }

    if (!userAccuracyCircle) {
      userAccuracyCircle = new google.maps.Circle({ map, strokeColor: '#1479ff', strokeOpacity: .45, strokeWeight: 1, fillColor: '#1479ff', fillOpacity: .1 });
    }
    userAccuracyCircle.setCenter(currentPosition);
    userAccuracyCircle.setRadius(position.coords.accuracy);
    map.setCenter(currentPosition);
    map.setZoom(16);
    showLocationStatus(`You are at ${coordinates} · accuracy approximately ${Math.round(position.coords.accuracy)} m`);
    pendingUserLocation = null;
  } catch (error) {
    pendingUserLocation = position;
    showLocationStatus(`Location found at ${coordinates}, but the map marker could not be displayed. Check that Google Maps loaded correctly.`);
  }
}

async function locateUser() {
  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
    elements.locate.textContent = 'Locate me';
    showLocationStatus('Live location tracking stopped.');
    return;
  }
  if (!window.isSecureContext) {
    showLocationStatus('Current location requires HTTPS or a localhost address.');
    return;
  }
  if (!navigator.geolocation) {
    showLocationStatus('Location is not supported by this browser.');
    return;
  }

  if (navigator.permissions?.query) {
    try {
      const permission = await navigator.permissions.query({ name: 'geolocation' });
      if (permission.state === 'denied') {
        showLocationStatus('Location is blocked for this site. Allow location permission in the browser and macOS Location Services, then reload the page.');
        return;
      }
    } catch {
      // Some browsers expose geolocation but do not expose its permission state.
    }
  }

  elements.locate.textContent = 'Stop locating';
  showLocationStatus('Waiting for location permission and a high-accuracy position…');
  locationWatchId = navigator.geolocation.watchPosition(position => {
    displayUserLocation(position);
  }, error => {
    const messages = {
      1: 'Location permission was denied or blocked by this browser. Allow location access, or open the site in Safari/Chrome, then try again.',
      2: 'Your current location is unavailable.',
      3: 'Location request timed out. Please try again.',
    };
    showLocationStatus(messages[error.code] || 'Unable to retrieve your current location.');
    if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
    elements.locate.textContent = 'Locate me';
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

async function loadFilteredProjects() {
  const permitYear = elements.permitExpiryYear.value;
  if (permitYear && !/^\d{4}$/.test(permitYear)) {
    elements.summary.textContent = 'Enter a valid four-digit permit expiry year.';
    return;
  }
  loadController?.abort();
  loadController = new AbortController();
  const { signal } = loadController;
  const version = ++loadVersion;
  const filters = selectedFilters();
  elements.applyFilters.disabled = true;
  elements.fit.disabled = true;
  showProgress('Searching the synchronized project database…');

  try {
    const result = await fetchEveryProject(filters, signal, version);
    if (version !== loadVersion) return;
    projects = result.projects.filter(matchesPermitExpiry);
    mappableProjects = projects.filter(validCoordinate);
    const missing = projects.length - mappableProjects.length;
    const permitFiltered = result.projects.length - projects.length;
    addMarkers();
    renderList();
    elements.fit.disabled = mappableProjects.length === 0;
    const synchronized = result.syncedAt ? ` Last synchronized ${new Date(result.syncedAt).toLocaleString('en-MY')}.` : '';
    elements.summary.textContent = `${projects.length} of ${result.total} projects match; ${mappableProjects.length} have valid coordinates and are mapped.${missing ? ` ${missing} are still listed but cannot be mapped exactly.` : ''}${permitFiltered ? ` ${permitFiltered} were excluded by permit year.` : ''}${synchronized}`;
  } catch (error) {
    if (error.name !== 'AbortError' && version === loadVersion) {
      elements.summary.textContent = `Could not load projects: ${error.message}`;
    }
  } finally {
    if (version === loadVersion) elements.applyFilters.disabled = false;
  }
}

async function startMap() {
  map = new google.maps.Map(elements.map, { center: { lat: 3.139, lng: 101.6869 }, zoom: 11, mapTypeControl: false, streetViewControl: false, fullscreenControl: true });
  elements.message.remove();
  elements.searchType.value = DEFAULT_FILTERS.search_type;
  elements.keyword.value = DEFAULT_FILTERS.q;
  elements.state.value = DEFAULT_FILTERS.state;
  elements.projectStatus.value = DEFAULT_FILTERS.statusProjek;
  elements.count.textContent = '0';
  elements.fit.disabled = true;
  elements.locate.disabled = false;
  elements.summary.textContent = 'Choose your filters, then click Search projects.';
  if (pendingUserLocation) displayUserLocation(pendingUserLocation);
}

function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Google Maps did not finish loading. Check that the key allows the Maps JavaScript API.')), 15000);
    window.__teduhMapsReady = () => { window.clearTimeout(timeout); resolve(); };
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__teduhMapsReady&v=weekly`;
    script.async = true; script.defer = true; script.onerror = () => { window.clearTimeout(timeout); reject(new Error('Google Maps could not be loaded. Check the API key and network connection.')); };
    document.head.append(script);
  });
}

async function connect(key) {
  try {
    await loadGoogleMaps(key); localStorage.setItem(KEY_STORAGE, key);
    await startMap();
  } catch (error) {
    elements.error.textContent = error.message; elements.error.hidden = false; elements.dialog.showModal();
  }
}

elements.form.addEventListener('submit', event => { event.preventDefault(); elements.error.hidden = true; elements.dialog.close(); connect(elements.key.value.trim()); });
elements.cancel.addEventListener('click', () => elements.dialog.close());
elements.filterForm.addEventListener('submit', event => { event.preventDefault(); loadFilteredProjects(); });
elements.state.addEventListener('change', () => loadDistricts(elements.state.value));
elements.district.addEventListener('change', () => loadCities(elements.district.value));
elements.priceMin.addEventListener('change', updateMaximumPrices);
elements.resetFilters.addEventListener('click', async () => {
  elements.searchType.value = DEFAULT_FILTERS.search_type;
  elements.keyword.value = DEFAULT_FILTERS.q;
  elements.state.value = DEFAULT_FILTERS.state;
  elements.projectStatus.value = DEFAULT_FILTERS.statusProjek;
  elements.priceMin.value = DEFAULT_FILTERS.pricemin;
  elements.priceMax.value = DEFAULT_FILTERS.pricemax;
  elements.permitExpiryYear.value = '';
  updateMaximumPrices();
  await loadDistricts(DEFAULT_FILTERS.state);
  clearProjectResults();
});
elements.locate.addEventListener('click', locateUser);
elements.fit.addEventListener('click', () => { if (markers.length) map.fitBounds(bounds, 40); });

const configuredKey = applicationConfig.googleMapsApiKey?.trim();
const storedKey = localStorage.getItem(KEY_STORAGE)?.trim();
const startupKey = configuredKey || storedKey;
if (startupKey) connect(startupKey); else elements.dialog.showModal();
