# ==========================================
# SayApp Bank Bridge — Production Dockerfile
# Multi-stage lightweight build (< 150MB) for Koyeb / Render Free Tier
# ==========================================

FROM node:20-slim AS runner

# Install essential dependencies for native sharp/onnxruntime binaries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=8080

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy patching script and patch endpoints
COPY scripts/ scripts/
RUN node scripts/patch-mbbank.js
RUN curl -sSL -o /tmp/model.onnx https://raw.githubusercontent.com/thedtvn/mbbank-capcha-ocr/master/mb_capcha_ocr/model.onnx && \
    cp /tmp/model.onnx /app/node_modules/mbbank/model.onnx || true && \
    cp /tmp/model.onnx /app/model.onnx || true
ENV MB_MODEL_PATH=/app/model.onnx

# Copy source code
COPY src/ src/

# Create non-root user security policy
USER node

# Expose standard Koyeb / Cloud Run port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "src/server.js"]
