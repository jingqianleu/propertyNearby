# TEDUH Completed Project Map

A browser-only Google Maps viewer for TEDUH private-project records. It starts with:

`state=14` (Kuala Lumpur) and `statusProjek=5` (Siap Dengan CCC).

## Run it

Serve this folder with any static web server, for example:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000` and paste a Google Maps JavaScript API key. The key is kept in this browser's local storage; it is not written into the project files.

To load Google Maps immediately whenever the app opens, put a browser-restricted key in `config.js`:

```js
window.TEDUH_CONFIG = {
  googleMapsApiKey: 'YOUR_BROWSER_RESTRICTED_KEY',
};
```

When configured, Google Maps initializes first on page load. Otherwise, the app reuses the key saved by the one-time dialog. Do not commit an unrestricted key; allow only the app's HTTP referrers and the Maps JavaScript API.

In Google Cloud, enable **Maps JavaScript API** and restrict the key to your deployed domain (and `http://localhost:8000/*` while testing). The application mirrors TEDUH's project-search filters: project/developer keyword, state, district, city, status, and minimum/maximum price. It does not retrieve project results automatically when the page opens or refreshes; searching begins only after the user clicks **Search projects**. Choosing a state loads its TEDUH district list into the District selector. The **Locate me** button is available immediately and starts continuous high-accuracy browser tracking; it places a separate marker and accuracy circle when Google Maps is ready, and becomes **Stop locating** while tracking. The application also provides a manual four-digit year filter for the latest permit expiry because TEDUH does not expose that field as a search parameter. The application retrieves every matching API page, then maps only projects that contain valid latitude and longitude values. Project cards and map popups show the latest permit expiry date supplied by TEDUH. The application also retrieves each project's TEDUH detail record to show its published minimum-to-maximum unit price range and component prices. Records without coordinates remain listed but cannot be plotted exactly. To avoid thousands of simultaneous API requests and map markers, a search must return 2,000 projects or fewer.
