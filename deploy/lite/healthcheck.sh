#!/bin/sh
set -eu

# Run locally on the server after the service is started. This checks only the
# loopback API; public TLS and DNS remain separate checks.
curl --fail --silent --show-error http://127.0.0.1:8080/api/health
