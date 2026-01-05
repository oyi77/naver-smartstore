# Naver SmartStore Scraper

A high-performance, undetected API for scraping Naver SmartStore product details.

## Features

-   **Undetectable**: Integrated `puppeteer-extra-plugin-stealth` and rotating residential proxies (Thordata).
-   **High Performance**: Optimized for speed with resource blocking (images/fonts) and parallel proxy validation.
-   **Smart Caching**: SQLite-backed caching to minimize redundant requests.
-   **Configurable**: Granular control over concurrency and proxy distribution.

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

**Example**
```bash
curl "http://localhost:3000/naver?url=https://smartstore.naver.com/store/products/12345"
```

## Evasion & Proxy Techniques

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

### 3. Smart Proxy Management
- **Pre-Validation**: The `ProxyManager` validates proxies specifically against **Naver** endpoints before adding them to the active pool.
- **Parallel Testing**: validation runs in batches (concurrency of 200) to quickly filter thousands of proxies.
- **Latency Checking**: Only proxies with response times under 2.5s are accepted.
- **Rotation Strategy**: Browsers are rotated automatically upon detection or network failure.

## Testing
Run specific test suites via NPM scripts:

-   `npm run test:stealth-v3`: Run concurrent scraping tests.
-   `npm run test:captcha`: Test manual CAPTCHA solving flow (Telegram).
