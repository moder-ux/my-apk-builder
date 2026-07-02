# ---------------------------------------------------------
# APK Forge — production image
# Bundles Node.js + a JDK + the Android SDK command-line tools,
# because gradlew needs all three to run `assembleDebug`.
# ---------------------------------------------------------
FROM eclipse-temurin:17-jdk-jammy AS base

# ---- System deps: git (cloning), Node.js (server), unzip/curl (SDK install) ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl unzip ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ---- Android SDK command-line tools ----
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH="${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools"

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    curl -o /tmp/cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip && \
    unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools && \
    mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest && \
    rm /tmp/cmdline-tools.zip

# Accept licenses non-interactively, then install the SDK packages most
# Android Gradle projects need. Adjust versions to match the repos you expect.
RUN yes | sdkmanager --licenses > /dev/null && \
    sdkmanager \
      "platform-tools" \
      "platforms;android-34" \
      "build-tools;34.0.0"

# ---- App ----
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./
COPY frontend/ ../frontend/

ENV PORT=5000
ENV WORK_DIR=/tmp/apk-builds
ENV DOWNLOAD_DIR=/app/backend/public/downloads

EXPOSE 5000
CMD ["node", "server.js"]
