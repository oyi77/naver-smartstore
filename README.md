# Naver SmartStore Scraper

A high-performance, undetected API for scraping Naver SmartStore product details.

## Features

-   **Undetectable**: Integrated `puppeteer-extra-plugin-stealth` and rotating residential proxies (Thordata).
-   **High Performance**: Optimized for speed with resource blocking (images/fonts) and parallel proxy validation.
-   **Smart Caching**: SQLite-backed caching to minimize redundant requests.
-   **Configurable**: Granular control over concurrency and proxy distribution.
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

### 3. Smart Proxy Management
- **Pre-Validation**: The `ProxyManager` validates proxies specifically against **Naver** endpoints before adding them to the active pool.
- **Parallel Testing**: validation runs in batches (concurrency of 200) to quickly filter thousands of proxies.
- **Latency Checking**: Only proxies with response times under 2.5s are accepted.
- **Rotation Strategy**: Browsers are rotated automatically upon detection or network failure.

### Evasion Flow : 
- Using referer and correct user agent + fingerprint should able to access store page
- From store page click random product id (this should trigger normal flow + including the referer and user interaction)
- After the product page opened, it should able to fetch any other product data from there with 200 success response
- Proxy is rarely needed when our IP is not banned, the requirement or process to make our IP banned is pretty easy. Juat do wrong request, using wrong useragent + fingerprint + hit 429 over and over again, mostly hit it more than 10 times, you will need new IP after that. or lets say if you not change the IP, you will need to fill captcha every page changes


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


## Testing
Run specific test suites via NPM scripts:

-   `npm run test:stealth-v3`: Run concurrent scraping tests.
-   `npm run test:captcha`: Test manual CAPTCHA solving flow (Telegram).
