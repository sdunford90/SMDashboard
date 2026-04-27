#!/bin/bash
set -e

# Install npm dependencies in case they changed in the merge.
npm install --no-audit --no-fund
