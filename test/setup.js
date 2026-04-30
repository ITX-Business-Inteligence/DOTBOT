// Setup compartido para los tests. Cada archivo de test debe hacer:
//   require('./setup');
// como PRIMERA linea, antes de cualquier require que toque src/.
//
// Llena env vars con valores de prueba SI no estan ya seteadas. La logica
// pura que testeamos no usa estos valores — solo satisface los required()
// de src/config/index.js.

process.env.NODE_ENV          = process.env.NODE_ENV          || 'test';
process.env.DB_USER           = process.env.DB_USER           || 'test_user';
process.env.DB_PASSWORD       = process.env.DB_PASSWORD       || 'test_password';
process.env.DB_NAME           = process.env.DB_NAME           || 'test_db';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.SAMSARA_API_TOKEN = process.env.SAMSARA_API_TOKEN || 'samsara_test';
process.env.JWT_SECRET        = process.env.JWT_SECRET        || 'test_jwt_secret_at_least_64_chars_long_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
process.env.COOKIE_SECRET     = process.env.COOKIE_SECRET     || 'test_cookie_secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
