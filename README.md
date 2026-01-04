# Naver SmartStore Scraper

An undetectable API for scraping Naver SmartStore product details, merging data from internal endpoints.

## Features
-   **Undetectable**: Uses `puppeteer-extra-plugin-stealth`, proxy rotation (Thordata), and User-Agent rotation.
-   **Performant**: Blocks images/fonts for faster scraping (<6s target).
-   **Cached**: Uses SQLite (`better-sqlite3`) with "Cache-First" strategy to minimize requests.
-   **Easy Access**: Includes Ngrok script for local tunneling.

## Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Configuration**:
    The proxy configuration is currently hardcoded in `src/controllers/ProductController.ts`. Update if needed.

3.  **Run Development Server**:
    ```bash
    npm run dev
    ```

4.  **Expose via Ngrok**:
    ```bash
    ./ngrok.sh
    ```

## API Usage

### `GET /naver`
Retrives product details.

**Query Parameters**:
-   `productUrl`: The full URL of the Naver SmartStore product.

**Example**:
```bash
curl "http://localhost:3000/naver?productUrl=https://smartstore.naver.com/store/products/12345"
```

**Response**:
```json
{
  "product": { ... },
  "benefits": { ... },
  "metadata": {
    "scrapedAt": "2024-01-01T00:00:00Z",
    "latencyMs": 1234
  }
}
```

## Testing
Run unit tests:
```bash
npm test
```
