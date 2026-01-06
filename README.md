# Naver SmartStore Scraper

A high-performance, undetected API for scraping Naver SmartStore product details.

## Features

-   **Undetectable**: Integrated `puppeteer-extra-plugin-stealth` with intelligent UA/proxy whitelisting.
-   **High Performance**: Direct-first strategy (tries direct connection before proxy) for optimal speed.
-   **Smart Caching**: SQLite-backed caching to minimize redundant requests.
-   **UA Whitelist**: Automatically tracks and prefers User Agents that successfully bypass detection.
-   **Proxy Whitelist**: Tracks working proxies and dynamic source management.
-   **Configurable**: Granular control over concurrency and proxy distribution.
-   **Dev Endpoints**: Management APIs for UAs, proxies, and sources.
-   **Dockerized**: Containerized for easy deployment and resource management.

## Background Story
- I made this app to have queue for better production environment in the future, so every request would become a queue, and the response will be cached at least 1 hour. The reason is to prevent rate-limit hit, and also to make the application more robust.
- I also make a boilerplate for the visionService, its for throwing the captcha either into AI or openCV later on, if we cant evade captcha easily. Or by manually sending the captcha to telegram, and we can answer the captcha manually

## Evasion & Proxy Usage

To ensure high success rates and avoid detection, this scraper employs a multi-layered approach:

### 1. Advanced Fingerprinting
We don't just rotate User-Agents. I inject complete, consistent browser fingerprints using **`fingerprint-injector`** and **`fingerprint-generator`**. This ensures that:
- `navigator.userAgent` matches `navigator.platform`.
- Screen resolution, hardware concurrency, and device memory are consistent with the emulated device.
- WebGL and Canvas fingerprints are randomized but realistic.

### 2. Stealth Plugin
Integrated **`puppeteer-extra-plugin-stealth`** to patch common bot detection leaks:
- Hides `navigator.webdriver`.
- Mocks Chrome specific runtime properties.
- Fixes `navigator.languages` and other discrepancies.

### 3. Advanced Proxy Management
- **Multi-Format Support**: Load proxies from JSON, TXT, CSV files (local or remote URLs)
  - Remote: `https://example.com/proxies.json`, `https://example.com/proxies.txt`, `https://example.com/proxies.csv`
  - Local: `./data/my-proxies.json`
  - Inline: `http://user:pass@1.2.3.4:8080`, `socks5://5.6.7.8:1080`
  - **Auto-Refresh**: Remote URLs are automatically re-fetched every validation interval (configurable, default 30min)
- **Rotating Proxy Integration**: Native support for rotating proxy providers
  - **Webshare**: API integration with auto-refresh (`webshare.io`)
  - **Thordata/SmartProxy**: Session-based sticky IPs (`thordata.io`, `smartproxy.com`)
  - **Provider Management**: Add/remove providers via API or environment variables
- **Performance Optimizations**:
  - Connection pooling for proxy validation
  - Parallel IP and Naver access testing
  - Incremental validation (only re-validate old proxies)
  - Smart batch sizing based on success rates
- **Intelligent Rotation Strategies**:
  - `LATENCY_BASED`: Prefer lowest latency proxies (default)
  - `ROUND_ROBIN`: Evenly distribute load
  - `WEIGHTED`: Balance by success rate and latency
  - `STICKY_SESSION`: Maintain same proxy per session
  - `RANDOM`: Randomized selection
- **Naver-Specific Validation**: Pre-validates proxies against Naver endpoints
- **Whitelist System**: Auto-tracks working proxies for priority selection
- **Dynamic Sources**: Add/remove proxy sources via API
- **Comprehensive Metrics**: Real-time stats on pool health, latency, success rates

### 4. Intelligent UA Management
- **Whitelist System**: Tracks User Agents that successfully bypass Naver's detection.
- **Retry-Until-Success**: Never gives up on UNSUPPORTED_BROWSER errors - keeps trying new UAs.
- **Preference Logic**: 80% chance to use known-good UAs, 20% for discovery.
- **Persistent Storage**: UA whitelist survives server restarts (`data/ua_whitelist.json`).

### Evasion Flow:
- Using referer and correct user agent + fingerprint should  be able to access store page
- From store page click random product id (this should trigger normal flow + including the referer and user interaction)
- After the product page opened, it should be able to fetch any other product data from there with 200 success response
- Proxy is rarely needed when our IP is not banned. The requirement or process to make our IP banned is pretty easy: Just do wrong request, using wrong useragent + fingerprint + hit 429 over and over again, mostly hit it more than 10 times, you will need new IP after that. or lets say if you not change the IP, you will need to fill captcha every page changes


## Setup

1.  **Install Dependencies**
    ```bash
    npm install
    ```

2.  **Configuration**
    Copy `.env.example` to `.env` and configure accordingly:
    ```bash
    cp .env.example .env
    ```

    ### Proxy Configuration (`USE_PROXY`)
    - `true`: Enable proxies for all browsers (Default).
    - `false` / `0`: Disable proxies completely.
    - `1`: Enable proxy for exactly **1** browser instance.
    - `-1`: Enable proxies for all browsers **except 1**.

    ### Concurrency
    - `MAX_BROWSERS`: Number of concurrent browser instances.
    - `TABS_PER_BROWSER`: Number of tabs per browser instance.

    ### Debugging
    - `HEADLESS`: Set to `false` to see the browser UI (Default: `true`).
    - `LOG_LEVEL`: Logging verbosity (debug, info, warn, error).
    - `DEBUG`: Generic debug flag.

3.  **Run Development Server**
    ```bash
    npm run dev
    ```

## API Usage

### Get Product Details
`GET /naver`

**Query Parameters**
-   `url`: Autodetect URL of the Naver SmartStore
-   `productUrl` (Optional): product url
-   `storeUrl` (Optional): store url
-   `categoryUrl` (Optional): category url
-   `proxy` (Optional): Custom proxy URL for this specific request.
-   `wait` (Optional): Wait for the job to complete or fail before returning the response.
-   `refresh` (Optional): Refresh the cache for this specific request.

**Example**
```bash
curl "http://localhost:3000/naver?url=https://smartstore.naver.com/store/products/12345"
```

### Development Endpoints

#### User Agent Management
- `POST /dev/ua` - Add working UA to whitelist
  ```bash
  curl -X POST http://localhost:3000/dev/ua \
    -H "Content-Type: application/json" \
    -d '{"userAgent": "Mozilla/5.0 (Windows NT 10.0...)"}'  
  ```
- `GET /dev/ua` - List all working UAs
  ```bash
  curl http://localhost:3000/dev/ua
  ```

#### Proxy Management  
- `GET /dev/proxy` - List proxies (filters: `working`, `naverReady`, `type`, `protocol`)
  ```bash
  curl "http://localhost:3000/dev/proxy?naverReady=true&type=residential"
  ```
- `POST /dev/proxy` - Add proxy manually
  ```bash
  curl -X POST http://localhost:3000/dev/proxy \
    -H "Content-Type: application/json" \
    -d '{"host":"1.2.3.4","port":8080,"protocol":"http","username":"user","password":"pass"}'
  ```
- `POST /dev/proxy/upload` - Upload proxy file (JSON/TXT/CSV)
  ```bash
  curl -X POST http://localhost:3000/dev/proxy/upload \
    -F "file=@proxies.txt"
  ```
- `GET /dev/proxy/stats` - Get comprehensive pool statistics
  ```bash
  curl http://localhost:3000/dev/proxy/stats
  ```

#### Proxy Source Management
- `GET /dev/proxy/sources` - List proxy sources
- `POST /dev/proxy/sources` - Add proxy source (supports remote JSON/TXT/CSV URLs)
  ```bash
  curl -X POST http://localhost:3000/dev/proxy/sources \
    -H "Content-Type: application/json" \
    -d '{"name":"my-source","url":"https://example.com/proxies.json"}'
  ```
- `DELETE /dev/proxy/sources/:name` - Delete proxy source

#### Rotating Proxy Providers
- `GET /dev/proxy/providers` - List all rotating providers
  ```bash
  curl http://localhost:3000/dev/proxy/providers
  ```
- `POST /dev/proxy/providers` - Add rotating provider
  ```bash
  # Webshare example
  curl -X POST http://localhost:3000/dev/proxy/providers \
    -H "Content-Type: application/json" \
    -d '{"name":"webshare","type":"webshare","config":{"apiKey":"YOUR_API_KEY","mode":"list","protocol":"http"}}'
  
  # Thordata/SmartProxy example
  curl -X POST http://localhost:3000/dev/proxy/providers \
    -H "Content-Type: application/json" \
    -d '{"name":"smartproxy","type":"thordata","config":{"username":"USER","password":"PASS","endpoint":"gate.smartproxy.com:7000"}}'
  ```
- `DELETE /dev/proxy/providers/:name` - Remove rotating provider


## Testing
Run specific test suites via NPM scripts:

-   `npm run test:stealth-v3`: Run concurrent scraping tests.
-   `npm run test:captcha`: Test manual CAPTCHA solving flow (Telegram).
```
