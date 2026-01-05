#!/bin/bash

# Configuration
IMAGE_NAME="ghcr.io/oyi77/naver-smartstore"
# Use a timestamp tag for versioning
VERSION_TAG="$(date +%Y%m%d-%H%M%S)"

echo "Starting Docker build and push process..."
echo "Target Image: $IMAGE_NAME"
echo "Version Tag: $VERSION_TAG"

# Check for docker login (basic check)
if ! docker system info > /dev/null 2>&1; then
  echo "Error: Docker is not running or you don't have permission."
  exit 1
fi

# Build
echo "Building image..."
docker build -t "$IMAGE_NAME:latest" .

if [ $? -ne 0 ]; then
    echo "Docker build failed."
    exit 1
fi

# Push
echo "Pushing image to GHCR..."
docker push "$IMAGE_NAME:latest"

if [ $? -ne 0 ]; then
    echo "Docker push failed. Make sure you are logged in to GHCR (docker login ghcr.io)."
    exit 1
fi

echo "Successfully built and pushed $IMAGE_NAME:latest"
