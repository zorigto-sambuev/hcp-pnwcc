# Use the official Playwright image which includes Node.js and Chromium.
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

# Set the working directory inside the container.
WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package.json package-lock.json* ./

# Install project dependencies.
RUN npm install --omit=dev && npm cache clean --force

# Create directories for screenshots and temporary files
RUN mkdir -p /app/screenshots /app/temp

# Copy all application files
COPY server.mjs ./server.mjs
COPY playwright_script.mjs ./playwright_script.mjs
COPY run-local-debug.mjs ./run-local-debug.mjs
COPY instrument.mjs ./instrument.mjs

# Create a non-root user for security (Render best practice)
RUN groupadd -r appuser && useradd -r -g appuser -u 1001 appuser

# Change ownership of app directory to appuser
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Set environment variables for the application.
ENV PORT=8080
ENV HEADLESS=1
ENV NODE_ENV=production

# Expose the port to allow external access.
EXPOSE 8080

# Health check for Render
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

# The command to start the application when the container runs.
CMD ["npm", "start"]