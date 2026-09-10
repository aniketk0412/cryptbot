# Use Node.js 18 LTS Alpine base image for minimal footprint (~120MB)
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies cleanly
RUN npm ci --only=production

# Copy source code and config files
COPY tsconfig.json ecosystem.config.cjs ./
COPY src/ ./src/
COPY app/ ./app/
COPY data/ ./data/

# Expose live dashboard port
EXPOSE 1000

# Set environment to production
ENV NODE_ENV=production
ENV PORT=1000

# Run bot using node ts-node directly or start script
CMD ["npm", "start"]
