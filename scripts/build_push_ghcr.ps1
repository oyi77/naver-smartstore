# Configuration
$ImageName = "ghcr.io/oyi77/naver-smartstore"

Write-Host "Starting Docker build and push process..."
Write-Host "Target Image: $ImageName"

# Check if Docker is running
docker system info | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker is not running or accessible."
    exit 1
}

# Build
Write-Host "Building image..."
docker build -t "${ImageName}:latest" .

if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker build failed."
    exit 1
}

# Push
Write-Host "Pushing image to GHCR..."
docker push "${ImageName}:latest"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker push failed. Make sure you are logged in to GHCR (docker login ghcr.io)."
    exit 1
}

Write-Host "Successfully built and pushed ${ImageName}:latest" -ForegroundColor Green
