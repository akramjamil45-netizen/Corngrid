'use strict';

// Partner Program composer: partner API, admin review API, and the commission
// engine, wired into the shared sandbox event bus and node registry.

const { registerPartnerApplications } = require('./partner-applications');
const path = require('node:path');
const { createPartnerApi } = require('./partner-api');
const { createPartnerAdminApi } = require('./partner-admin-api');
const { createCommissionService } = require('./commission-service');
const { createPartnerPayouts } = require('./partner-payouts');

function createPartnerSystem(app, db, { verifyToken, adminAuth, events, nodes, crypto, subscriptionApi, rateLimit, authenticateNodeRequest, storageDir }) {
  const payouts = createPartnerPayouts({ db, crypto, events });
  const commissionService = createCommissionService({ db, events, payouts });
  const partnerApi = createPartnerApi({ db, events, crypto, rateLimit, storageDir });
  const partnerAdminApi = createPartnerAdminApi({
    db, nodes, events,
    subscriptions: subscriptionApi,
    commissionService,
    storageDir: partnerApi.SUBMISSIONS_DIR
  });

  registerPartnerApplications(app, db, verifyToken, adminAuth.verifyToken, subscriptionApi, storageDir ? {directory:path.join(storageDir,'user-agreements')} : {});
  payouts.registerRoutes(app, verifyToken, adminAuth.verifyToken, rateLimit);
  partnerApi.registerRoutes(app, verifyToken);
  partnerAdminApi.registerRoutes(app, adminAuth.verifyToken, authenticateNodeRequest);

  // Commission generation hooks into subscription payment approvals.
  if (subscriptionApi && typeof subscriptionApi.onPaymentApproved === 'function') {
    subscriptionApi.onPaymentApproved(payment => commissionService.handlePaymentApproved(payment));
  }

  return { commissionService, partnerApi, partnerAdminApi, payouts };
}

module.exports = { createPartnerSystem };
