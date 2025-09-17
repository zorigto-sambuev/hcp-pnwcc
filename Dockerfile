# Use the official Playwright image which includes Node.js and Chromium.
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

# Install Xvfb for virtual display support (enables headed mode in containers)
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

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
COPY instrument.mjs ./instrument.mjs

# Create a non-root user for security (Render best practice)
RUN groupadd -r appuser && useradd -r -g appuser -u 1001 appuser

# Change ownership of app directory to appuser
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Set environment variables for the application.
ENV PORT=8080
ENV HEADLESS=0
ENV NODE_ENV=production

# Expose the port to allow external access.
EXPOSE 8080

# Health check for Render
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

# The command to start the application when the container runs.
# Use Xvfb to create virtual display for headed browser mode
CMD ["sh", "-c", "Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 & export DISPLAY=:99 && npm start"]