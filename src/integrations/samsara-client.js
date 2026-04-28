// Cliente Samsara API.
// Docs: https://developers.samsara.com/docs/getting-started
// Endpoints clave usados:
//   GET /fleet/hos/clocks  - HOS state en tiempo real por driver
//   GET /fleet/drivers     - roster
//   GET /fleet/vehicles    - flota
//   GET /fleet/hos/logs    - RODS detallados (paginated)

const axios = require('axios');
const config = require('../config');

const http = axios.create({
  baseURL: config.samsara.baseUrl,
  headers: {
    Authorization: `Bearer ${config.samsara.token}`,
    Accept: 'application/json',
  },
  timeout: 15000,
});

async function getDriverHosClocks(driverIds = null) {
  const params = {};
  if (driverIds && driverIds.length) params.driverIds = driverIds.join(',');
  const { data } = await http.get('/fleet/hos/clocks', { params });
  return data.data || [];
}

async function getDriverHosClock(driverId) {
  const all = await getDriverHosClocks([driverId]);
  return all[0] || null;
}

async function listDrivers({ active = true, limit = 500 } = {}) {
  const params = { limit };
  if (active !== null) params.driverActivationStatus = active ? 'active' : 'deactivated';
  const { data } = await http.get('/fleet/drivers', { params });
  return data.data || [];
}

async function listVehicles({ limit = 500 } = {}) {
  const { data } = await http.get('/fleet/vehicles', { params: { limit } });
  return data.data || [];
}

async function getDriverHosLogs(driverId, startMs, endMs) {
  const { data } = await http.get('/fleet/hos/logs', {
    params: {
      driverIds: driverId,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
    },
  });
  return data.data || [];
}

/**
 * Calcula tiempos disponibles HOS para un driver.
 * Devuelve minutos disponibles en cada limite (drive 11h, duty 14h, cycle 70h).
 */
function summarizeHosClock(clock) {
  if (!clock) return null;
  const drivingTimeMin = (clock.drivingTime || 0) / 60;
  const onDutyTimeMin = (clock.onDutyTime || 0) / 60;
  const cycleTimeMin = (clock.cycleTime || 0) / 60;
  return {
    driverId: clock.driver?.id || clock.driverId,
    driverName: clock.driver?.name || null,
    clockState: clock.clockState,
    drive: {
      usedMin: Math.round(drivingTimeMin),
      limitMin: 660, // 11 horas
      remainingMin: Math.max(0, 660 - Math.round(drivingTimeMin)),
    },
    duty: {
      usedMin: Math.round(onDutyTimeMin),
      limitMin: 840, // 14 horas
      remainingMin: Math.max(0, 840 - Math.round(onDutyTimeMin)),
    },
    cycle: {
      usedMin: Math.round(cycleTimeMin),
      limitMin: 4200, // 70 horas / 8 dias
      remainingMin: Math.max(0, 4200 - Math.round(cycleTimeMin)),
    },
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getDriverHosClocks,
  getDriverHosClock,
  listDrivers,
  listVehicles,
  getDriverHosLogs,
  summarizeHosClock,
};
