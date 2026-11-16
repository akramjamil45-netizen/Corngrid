(function(root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.CornGridExperienceModel = model;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';
  function checkoutState({ subscription, latestPayment: payment, order, provider, scheduledRenewal } = {}) {
    const method = provider || payment?.payment_method || 'duitnow';
    const active = subscription?.status === 'active';
    let step = 0, state = 'choose', title = 'Choose a plan', detail = 'Select a plan to see the amount, currency and payment options.', action = null;
    if (!order?.activated_at && payment?.status !== 'approved' && (payment && ['rejected', 'cancelled', 'failed', 'expired'].includes(payment.status) || order && ['failed', 'expired'].includes(order.status))) {
      step = 1; state = 'incomplete'; title = 'Payment not completed'; detail = payment?.rejection_reason || 'You can select a plan again or review the available payment methods.';
    } else if (active && (order?.activated_at || payment?.status === 'approved' || !payment)) {
      step = 3; state = 'active'; title = 'Access active'; detail = 'Your access is confirmed by CornGrid. Existing MT5 activation limits still apply.';
    } else if (payment?.status === 'approved' || order?.activated_at) {
      step = 3; state = 'attention'; title = 'Payment approved — review access'; detail = 'The payment is approved. Check the subscription status below for its start date, expiry or any access restriction.';
    } else if (order?.status === 'paid' || payment?.status === 'pending_approval') {
      step = 2; state = 'verification'; title = method === 'stripe' ? 'Card payment is being verified' : 'Awaiting administrator review';
      detail = method === 'stripe' ? 'CornGrid is checking the confirmed Stripe payment. Opening a return page does not activate access.' : 'Your DuitNow evidence has been submitted. Access activates after the administrator approves it.';
    } else if (payment) {
      step = 1; state = 'payment'; title = method === 'stripe' ? 'Complete your card payment' : 'Complete your DuitNow payment';
      detail = method === 'stripe' ? 'Continue to Stripe Checkout, then return here to check confirmation.' : 'Pay the displayed amount and submit the payment reference or receipt for review.';
    }
    if (active && payment && ['payment', 'verification', 'incomplete'].includes(state)) detail += ' Your current subscription remains active while this purchase is pending.';
    if (state === 'active' && scheduledRenewal) detail = 'Your renewal is confirmed and starts on ' + new Date(Number(scheduledRenewal.startsAt)).toLocaleDateString('en-GB') + '. Current access remains active.';
    if (state === 'verification' && method === 'stripe') action = 'Check payment status';
    return { step, state, title, detail, action, provider: method, complete: state === 'active' };
  }
  function attentionItems({ accounts, subscription, sandbox } = {}, time = Date.now()) {
    const items = [];
    if (!Array.isArray(accounts) || !subscription || !sandbox) return items;
    const access = subscription.subscription, payment = subscription.latestPayment;
    if (payment && ['pending_payment', 'pending_approval'].includes(payment.status)) items.push({ key: 'payment', title: payment.status === 'pending_approval' ? 'Payment awaiting verification' : 'Complete your payment', body: 'Review the current payment and next step in Subscription.', page: 'subscription', label: 'Review payment' });
    if (access?.status === 'active' && !subscription.scheduledRenewal && Number(access.expiresAt) > time && Number(access.expiresAt) - time <= 7 * 86400000) items.push({ key: 'expiry', title: 'Subscription expires soon', body: 'Check your expiry date and renewal options.', page: 'subscription', label: 'Review subscription' });
    if ((!access || access.status !== 'active') && !['pending_payment', 'pending_approval'].includes(payment?.status)) items.push({ key: 'access', title: 'Set up your subscription', body: 'Choose or review a subscription before deploying a managed sandbox.', page: 'subscription', label: 'View subscription' });
    if (!accounts.length) items.push({ key: 'account', title: 'Link your first MT5 account', body: 'Generate a pairing code and follow the existing account-linking instructions.', page: 'accounts', label: 'Link MT5 account' });
    const disconnected = accounts.filter(account => ['Offline', 'Authentication error'].includes(account.status));
    if (disconnected.length) items.push({ key: 'ea', title: disconnected.length + ' EA account' + (disconnected.length > 1 ? 's need' : ' needs') + ' attention', body: 'Check the last heartbeat, terminal and account connection.', page: 'monitoring', label: 'Open EA monitoring' });
    if (sandbox.health?.nextAction) items.push({ key: 'sandbox', ...sandbox.health.nextAction });
    else if (access?.status === 'active' && !(sandbox.sandboxes || []).length) items.push({ key: 'setup', title: 'Set up your first Sandbox', body: 'Choose an available strategy and connect your authorized MT5 account.', page: 'sandbox', label: 'Set up Sandbox' });
    return items;
  }
  return { checkoutState, attentionItems };
});
