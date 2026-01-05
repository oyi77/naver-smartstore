# Coding Challenge: Scalable & Undetectable Naver SmartStore Scraper

## Objective
Build a scalable and undetectable API to scrape product detail data from `smartstore.naver.com`. The scraper must retrieve raw JSON responses from internal APIs, specifically:
- `/benefits/by-product`
- `/i/v2/channels/{channeluid}/products/{productid}?withWindow=false`

The scraper must bypass anti-scraping mechanisms and return accurate data in real-time.

---

## Target URL Schema
Naver SmartStore product pages follow this structure:
`https://smartstore.naver.com/{store_name}/products/{product_id}`

**Example:**
- **Product Page:** [https://smartstore.naver.com/rainbows9030/products/11102379008](https://smartstore.naver.com/rainbows9030/products/11102379008)
- **Target JSON API:** `https://smartstore.naver.com/i/v2/channels/2v1EJ3Fas87nW0bkfGZ7m/products/11102379008?withWindow=false`

---

## Requirements

### 1. Scraping Logic
- **Extraction:** Capture raw JSON responses from the `/benefits/by-product` and Product Details endpoints.
- **Data Integrity:** Ensure the output matches the full structure of each target API.
- **Evasion Techniques:** 
    - Rotate Browser Fingerprints and IPs.
    - Implement request throttling and randomized delays.

### 2. API Development
- **Endpoint:** `GET /naver?productUrl={url}`
- **Example:** `GET https://your-api.com/naver?productUrl=https://smartstore.naver.com/minibeans/products/8768399445`
- **Response:** Merged or separate results from both internal APIs.

### 3. Tech Stack
- **Language:** JavaScript.
- **Preference:** TypeScript is a strong plus.

### 4. Hosting & Documentation
- **Hosting:** Publicly accessible via Ngrok or a similar tunnel.
- **Documentation:** Provide a comprehensive `README.md` for local setup and usage.

---

## Success Criteria
The API must meet the following benchmarks during evaluation:
- **Volume:** Successfully retrieve data for **1,000+ products**.
- **Latency:** Maintain an average latency of **≤ 6 seconds** per request.
- **Stability:** Error rate **≤ 5%** over **1 hour** of continuous testing.

---

## Scraping & Proxy Notes
- **Default Proxy:** `6n8xhsmh.as.thordata.net:9999:td-customer-mrscraperTrial-country-kr:P3nNRQ8C2`
- You are permitted to use alternative free or trial proxy providers.

---

## Deliverables
1. **Hosted API link** (e.g., Ngrok).
2. **Source code** (GitHub repository).
3. **README.md** containing:
    - Setup and execution instructions.
    - Detailed scraper explanation (evasion strategies, proxy usage).
    - API usage examples.

