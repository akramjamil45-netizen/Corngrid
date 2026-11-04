'use strict';

// Partner Program composer: partner API, admin review API, and the commission
// engine, wired into the shared sandbox event bus and node registry.

const { createPartnerApi } = require('./partner-api');
const { createPartnerAdminApi } = require('./partner-admin-api');
const { createCommissionService } = require('./commission-service');

function createPartnerSystem(app, db, { verifyToken, adminAuth, events, nodes, crypto, subscriptionApi, rateLimit, authenticateNodeRequest }) {
  const commissionService = createCommissionService({ db, events });
  const partnerApi = createPartnerApi({ db, events, crypto, rateLimit });
  const partnerAdminApi = createPartnerAdminApi({
    db, nodes, events,
    subscriptions: subscriptionApi,
    commissionService,
    storageDir: partnerApi.SUBMISSIONS_DIR
  });

  partnerApi.registerRoutes(app, verifyToken);
  partnerAdminApi.registerRoutes(app, adminAuth.verifyToken, authenticateNodeRequest);

  // Commission generation hooks into subscription payment approvals.
  if (subscriptionApi && typeof subscriptionApi.onPaymentApproved === 'function') {
    subscriptionApi.onPaymentApproved(payment => commissionService.handlePaymentApproved(payment));
  }

  return { commissionService, partnerApi, partnerAdminApi };
}

module.exports = { createPartnerSystem };
