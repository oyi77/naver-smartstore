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
# Build for linux/amd64 (standard for servers)
echo "Building image for linux/amd64..."
# Ensure buildx is available and use it for multi-platform builds if needed, 
# or just force the platform locally.
if docker buildx version > /dev/null 2>&1; then
    docker buildx build --platform linux/amd64 -t "$IMAGE_NAME:latest" --push .
else
    # Fallback to standard build with platform flag (might be slower or fail depending on setup)
    echo "Warning: docker buildx not found, trying standard build with --platform..."
    docker build --platform linux/amd64 -t "$IMAGE_NAME:latest" .
    docker push "$IMAGE_NAME:latest"
fi

if [ $? -ne 0 ]; then
    echo "Docker build failed."
    exit 1
fi

# Push is handled by buildx --push above
# echo "Pushing image to GHCR..."
# docker push "$IMAGE_NAME:latest"

if [ $? -ne 0 ]; then
   echo "Build/Push failed."
   exit 1
fi

echo "Successfully built and pushed $IMAGE_NAME:latest"
