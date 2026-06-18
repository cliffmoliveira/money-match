const { ulid } = require('ulid');
// Sortable, unguessable, unique id for click_id / conversion_id.
function newId() { return ulid(); }
module.exports = { newId };
