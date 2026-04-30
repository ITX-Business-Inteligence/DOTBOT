// MockSamsara — emula los endpoints de Samsara que samsara-client.js usa.
//
// Activacion: BOTDOT_MOCK_SAMSARA=true en .env
//
// Las respuestas siguen la shape que devuelve la API real (segun
// https://developers.samsara.com/docs) — esto es critico: si el mock
// devuelve una shape distinta a la real, el dia que swap a real, todo
// rompe. Mantengamos paridad de campos y nombres.
//
// Que ejercita:
//   ✓ Sync de drivers/vehicles (INSERT/UPDATE en local DB)
//   ✓ Sync de HOS clocks (driver_hos_cache poblado cada N min)
//   ✓ Tools samsara_* (que ahora leen del cache)
//   ✓ Scheduler (sync_runs con success/error)
//
// Que NO ejercita:
//   ✗ Real-world drift (turnover de drivers, vehiculos en taller, etc.)
//   ✗ Rate limit de Samsara (que es real en prod, no en mock)
//   ✗ Campos custom que tu fleet tenga configurados

const FLEET_DRIVERS = [
  { samsaraId: 'sams_d_001', name: 'Maria Gonzalez',     cdl: { number: 'TX12345678', state: 'TX', expiration: '2027-08-15' }, medicalCard: { expirationDate: '2026-09-30' }, endorsements: 'H,N' },
  { samsaraId: 'sams_d_002', name: 'Juan Hernandez',     cdl: { number: 'TX23456789', state: 'TX', expiration: '2026-12-01' }, medicalCard: { expirationDate: '2026-06-15' }, endorsements: 'H'   },
  { samsaraId: 'sams_d_003', name: 'Roberto Sanchez',    cdl: { number: 'TX34567890', state: 'TX', expiration: '2028-03-20' }, medicalCard: { expirationDate: '2027-01-10' }, endorsements: 'T'   },
  { samsaraId: 'sams_d_004', name: 'Sthepanie Michelle', cdl: { number: 'TX45678901', state: 'TX', expiration: '2027-05-12' }, medicalCard: { expirationDate: '2026-11-22' }, endorsements: ''    },
  { samsaraId: 'sams_d_005', name: 'Carlos Ramirez',     cdl: { number: 'TX56789012', state: 'TX', expiration: '2026-05-08' }, medicalCard: { expirationDate: '2026-05-30' }, endorsements: 'H,T,N' },
  { samsaraId: 'sams_d_006', name: 'Ana Lopez',          cdl: { number: 'TX67890123', state: 'TX', expiration: '2027-11-30' }, medicalCard: { expirationDate: '2026-08-04' }, endorsements: ''    },
  { samsaraId: 'sams_d_007', name: 'Luis Martinez',      cdl: { number: 'TX78901234', state: 'TX', expiration: '2028-01-15' }, medicalCard: { expirationDate: '2027-02-18' }, endorsements: 'H'   },
  { samsaraId: 'sams_d_008', name: 'Sofia Rodriguez',    cdl: { number: 'TX89012345', state: 'TX', expiration: '2026-07-25' }, medicalCard: { expirationDate: '2026-04-30' }, endorsements: ''    },
  { samsaraId: 'sams_d_009', name: 'Pedro Garcia',       cdl: { number: 'TX90123456', state: 'TX', expiration: '2027-09-09' }, medicalCard: { expirationDate: '2026-12-12' }, endorsements: 'T'   },
  { samsaraId: 'sams_d_010', name: 'Diana Torres',       cdl: { number: 'TX01234567', state: 'TX', expiration: '2028-06-30' }, medicalCard: { expirationDate: '2027-04-04' }, endorsements: ''    },
];

const FLEET_VEHICLES = [
  { samsaraId: 'sams_v_001', vin: '1FUJGLDR0CSBM0001', unit: '101', type: 'tractor', make: 'Freightliner', model: 'Cascadia',    year: 2022, licensePlate: 'TX 100AAA', licenseState: 'TX', annualInspection: '2026-02-15', oos: false },
  { samsaraId: 'sams_v_002', vin: '1FUJGLDR0CSBM0002', unit: '102', type: 'tractor', make: 'Freightliner', model: 'Cascadia',    year: 2023, licensePlate: 'TX 100AAB', licenseState: 'TX', annualInspection: '2025-11-10', oos: false },
  { samsaraId: 'sams_v_003', vin: '3HSDJSJR0CN500003', unit: '103', type: 'tractor', make: 'International', model: 'LT',        year: 2021, licensePlate: 'TX 100AAC', licenseState: 'TX', annualInspection: '2026-01-22', oos: true  },
  { samsaraId: 'sams_v_004', vin: '1XKYDP9X0NJ500004', unit: '104', type: 'tractor', make: 'Kenworth',     model: 'T680',        year: 2024, licensePlate: 'TX 100AAD', licenseState: 'TX', annualInspection: '2026-03-05', oos: false },
  { samsaraId: 'sams_v_005', vin: '1FUJA6CK0NH500005', unit: '105', type: 'tractor', make: 'Volvo',        model: 'VNL',         year: 2022, licensePlate: 'TX 100AAE', licenseState: 'TX', annualInspection: '2025-12-01', oos: false },
];

// HOS clocks: 5 estados realistas para que pruebes "drivers near limit"
// y demas. Los driverIds matchean con FLEET_DRIVERS.
const HOS_CLOCKS = [
  // Driver 1: fresca, 8h drive disponibles
  { driverId: 'sams_d_001', driverName: 'Maria Gonzalez',     clockState: 'on_duty_not_driving', drivingTimeSec: 3 * 3600, onDutyTimeSec: 4 * 3600,  cycleTimeSec: 30 * 3600 },
  // Driver 2: cerca del limite de 11h drive (60 min restantes)
  { driverId: 'sams_d_002', driverName: 'Juan Hernandez',     clockState: 'driving',             drivingTimeSec: 10 * 3600, onDutyTimeSec: 12 * 3600, cycleTimeSec: 50 * 3600 },
  // Driver 3: descansando
  { driverId: 'sams_d_003', driverName: 'Roberto Sanchez',    clockState: 'off_duty',            drivingTimeSec: 0,         onDutyTimeSec: 0,         cycleTimeSec: 25 * 3600 },
  // Driver 4: Sthepanie — fresh, lista para load
  { driverId: 'sams_d_004', driverName: 'Sthepanie Michelle', clockState: 'on_duty_not_driving', drivingTimeSec: 1 * 3600,  onDutyTimeSec: 2 * 3600,  cycleTimeSec: 20 * 3600 },
  // Driver 5: ~3h drive restante, 4h duty
  { driverId: 'sams_d_005', driverName: 'Carlos Ramirez',     clockState: 'driving',             drivingTimeSec: 8 * 3600,  onDutyTimeSec: 10 * 3600, cycleTimeSec: 45 * 3600 },
  // Driver 6: cycle casi exhausto (8h restantes)
  { driverId: 'sams_d_006', driverName: 'Ana Lopez',          clockState: 'on_duty_not_driving', drivingTimeSec: 5 * 3600,  onDutyTimeSec: 7 * 3600,  cycleTimeSec: 62 * 3600 },
  // Driver 7: sleeper berth
  { driverId: 'sams_d_007', driverName: 'Luis Martinez',      clockState: 'sleeper_berth',       drivingTimeSec: 0,         onDutyTimeSec: 0,         cycleTimeSec: 35 * 3600 },
  // Driver 8: fresca
  { driverId: 'sams_d_008', driverName: 'Sofia Rodriguez',    clockState: 'off_duty',            drivingTimeSec: 0,         onDutyTimeSec: 0,         cycleTimeSec: 18 * 3600 },
  // Driver 9: 2h drive restante
  { driverId: 'sams_d_009', driverName: 'Pedro Garcia',       clockState: 'driving',             drivingTimeSec: 9 * 3600,  onDutyTimeSec: 11 * 3600, cycleTimeSec: 55 * 3600 },
  // Driver 10: fresca, mucho cycle
  { driverId: 'sams_d_010', driverName: 'Diana Torres',       clockState: 'on_duty_not_driving', drivingTimeSec: 2 * 3600,  onDutyTimeSec: 3 * 3600,  cycleTimeSec: 22 * 3600 },
];

// Convenciones de shape Samsara (camelCase, nested objects para driver/vehicle).

async function listDrivers({ active = true, limit = 500 } = {}) {
  await sleep(50);
  return FLEET_DRIVERS.map(d => ({
    id: d.samsaraId,
    name: d.name,
    driverActivationStatus: 'active',
    licenseNumber: d.cdl.number,
    licenseState: d.cdl.state,
    licenseExpirationDate: d.cdl.expiration,
    medicalCard: d.medicalCard,
    endorsements: d.endorsements,
  })).slice(0, limit);
}

async function listVehicles({ limit = 500 } = {}) {
  await sleep(50);
  return FLEET_VEHICLES.map(v => ({
    id: v.samsaraId,
    vin: v.vin,
    name: v.unit,
    vehicleType: v.type,
    make: v.make,
    model: v.model,
    year: v.year,
    licensePlate: v.licensePlate,
    licenseState: v.licenseState,
    annualInspectionDate: v.annualInspection,
    outOfService: v.oos,
  })).slice(0, limit);
}

async function getDriverHosClocks(driverIds = null) {
  await sleep(50);
  const filtered = driverIds && driverIds.length
    ? HOS_CLOCKS.filter(c => driverIds.includes(c.driverId))
    : HOS_CLOCKS;
  return filtered.map(c => ({
    driver: { id: c.driverId, name: c.driverName },
    driverId: c.driverId,
    clockState: c.clockState,
    drivingTime: c.drivingTimeSec,
    onDutyTime: c.onDutyTimeSec,
    cycleTime: c.cycleTimeSec,
  }));
}

async function getDriverHosClock(driverId) {
  const all = await getDriverHosClocks([driverId]);
  return all[0] || null;
}

async function getDriverHosLogs(driverId, startMs, endMs) {
  // No interesa para v1 — el sync no usa logs detallados, solo clocks.
  await sleep(50);
  return [];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  listDrivers,
  listVehicles,
  getDriverHosClocks,
  getDriverHosClock,
  getDriverHosLogs,
};
