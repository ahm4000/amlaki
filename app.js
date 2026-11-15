'use strict';
// Startup file for hosting control panels (for example cPanel "Setup Node.js App").
// It starts the same website as `node server.js`.
const { server } = require('./server');
const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log('Amlaki running on port ' + port));
