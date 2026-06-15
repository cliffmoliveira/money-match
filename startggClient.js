const axios = require('axios');

const STARTGG_URL = 'https://api.start.gg/gql/alpha';

async function startgg(query, variables = {}, tokenOverride) {
  const token = tokenOverride || process.env.STARTGG_API_TOKEN;
  if (!token) throw new Error('Missing STARTGG_API_TOKEN in environment');

  const res = await axios.post(STARTGG_URL, { query, variables }, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.data.errors) {
    throw new Error(`StartGG errors: ${JSON.stringify(res.data.errors)}`);
  }
  return res.data.data;
}

module.exports = { startgg };
