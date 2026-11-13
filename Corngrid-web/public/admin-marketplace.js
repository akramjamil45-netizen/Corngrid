(() => {
  'use strict';
  let manager;
  window.CornGridAdminMarketplace={open(){manager ||= window.CornGridMarketplaceUI.createManager(document.getElementById('admin-marketplace-root'),'admin');return manager.open();}};
})();
