ARG BUILD_FROM
FROM $BUILD_FROM

# Install dependencies
RUN apk add --no-cache \
    nginx \
    nodejs \
    npm \
    curl \
    jq \
    tzdata \
    bash \
    s6-overlay

# Copy root filesystem
COPY rootfs /

# Make scripts executable
RUN chmod a+x \
    /usr/bin/speedtest_runner.sh \
    /usr/bin/speedtest_worker.js \
    /etc/cont-init.d/10-setup.sh \
    /etc/services.d/speedtest/run \
    /etc/services.d/nginx/run

# Labels
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_DESCRIPTION
ARG BUILD_NAME
ARG BUILD_REF
ARG BUILD_REPOSITORY
ARG BUILD_VERSION

LABEL \
    io.hass.name="${BUILD_NAME}" \
    io.hass.description="${BUILD_DESCRIPTION}" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="jburroughs" \
    org.opencontainers.image.title="${BUILD_NAME}" \
    org.opencontainers.image.description="${BUILD_DESCRIPTION}" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}
