'use strict';
const path = require('node:path');
const express = require('express');

// Register before public/index.html (the existing authentication screen).
module.exports = function registerMarketingRoutes(app, root) {
  const page = file => (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(root, file));
  };
  app.get(['/', '/index.html'], page('index.html'));
  app.get(/^\/en$/, (_req,res) => res.redirect(301,'/en/'));
  app.get('/en/', page('en/index.html'));
  app.get(/^\/corngrid-ea\/$/, (_req,res) => res.redirect(301,'/corngrid-ea'));
  app.get(['/corngrid-ea', '/corngrid-ea.html'], page('corngrid-ea.html'));
  // Keep the original app route available in standalone Node hosting as well as IIS.
  app.use('/promote/terminal-app', express.static(path.join(root, 'promote/terminal-app'), { maxAge: 0 }));
  for (const file of ['infrastructure.css','site.js']) app.get('/'+file,page(file));
  app.use('/locales',express.static(path.join(root,'locales'),{maxAge:0,index:false}));
};
