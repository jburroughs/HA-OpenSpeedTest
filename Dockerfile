ARG BUILD_FROM
FROM $BUILD_FROM

# Install dependencies
RUN apk add --no-cache \
    nginx \
    nodejs \
    npm \
    python3 \
    py3-pip \
    curl \
    jq \
    tzdata \
    bash

# Install speedtest-cli (Ookla CLI compatible) and requests
RUN pip3 install --break-system-packages requests || pip3 install requests

# Install nodejs speedtest client for OpenSpeedTest
RUN npm install -g axios

# Copy root filesystem
COPY rootfs /

# Make scripts executable
RUN chmod +x /usr/bin/speedtest_runner.sh \
    && chmod +x /usr/bin/speedtest_worker.js \
    && chmod +x /etc/cont-init.d/10-setup.sh \
    && chmod +x /etc/services.d/speedtest/run \
    && chmod +x /etc/services.d/nginx/run

# Set build arguments
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_DESCRIPTION
ARG BUILD_NAME
ARG BUILD_REF
ARG BUILD_REPOSITORY
ARG BUILD_VERSION

# Labels
LABEL \
    io.hass.name="${BUILD_NAME}" \
    io.hass.description="${BUILD_DESCRIPTION}" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="OpenSpeedTest Monitor" \
    org.opencontainers.image.title="${BUILD_NAME}" \
    org.opencontainers.image.description="${BUILD_DESCRIPTION}" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}
