'use strict';
// Use the SDK's versioned API contract and Dashboard payment method settings.
function createStripeClient(key, options = {}) {
  const Stripe = require('stripe');
  return new Stripe(key, { maxNetworkRetries: 2, timeout: 12000, ...options });
}
module.exports = { createStripeClient };
