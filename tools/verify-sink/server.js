'use strict';
// node tools/verify-sink/server.js [port]  (trong hubv: http://sink:4100/...)
const { createSink } = require('./sink');
const port = Number(process.argv[2] || process.env.PORT || 4100);
createSink().listen(port, () => console.log(`verify-sink nghe cổng ${port}`));
