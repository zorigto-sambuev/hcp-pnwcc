# Use the official Playwright image which includes Node.js and Chromium.
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

# Set the working directory inside the container.
WORKDIR /app

# Copy the package.json and package-lock.json files to the working directory.
COPY package.json package-lock.json* ./

# Install project dependencies.
RUN npm install --omit=dev

# Copy the server and Playwright script files into the container.
COPY server.mjs ./server.mjs
COPY playwright_script.mjs ./playwright_script.mjs

# Set environment variables for the application.
ENV PORT=8080
ENV HEADLESS=1

# Expose the port to allow external access.
EXPOSE 8080

# The command to start the application when the container runs.
CMD ["npm", "start"]