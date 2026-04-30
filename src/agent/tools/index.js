// Registro central de herramientas del agente.
// Cada herramienta exporta { definition, handler }.

const samsara = require('./samsara');
const cfr = require('./cfr');
const sms = require('./sms');
const audit = require('./audit');
const escalate = require('./escalate');

const TOOLS = {
  // Samsara
  samsara_get_driver_hos: samsara.getDriverHos,
  samsara_search_driver: samsara.searchDriver,
  samsara_get_drivers_near_limit: samsara.getDriversNearLimit,
  samsara_get_vehicle_status: samsara.getVehicleStatus,

  // Reglas HOS
  check_assignment_compliance: samsara.checkAssignmentCompliance,

  // CFR / regulacion
  search_cfr: cfr.searchCfr,
  get_cfr_section: cfr.getCfrSection,

  // SMS / BASICs / violaciones
  query_basics_status: sms.queryBasicsStatus,
  query_top_violations: sms.queryTopViolations,
  query_driver_inspections: sms.queryDriverInspections,
  query_dataqs_candidates: sms.queryDataQsCandidates,

  // Audit
  log_decision: audit.logDecision,
  log_refused_request: audit.logRefusedRequest,
  log_off_topic: audit.logOffTopic,

  // Escalation
  escalate_to_compliance: escalate.escalateToCompliance,
};

const TOOL_DEFINITIONS = [
  samsara.getDriverHos.definition,
  samsara.searchDriver.definition,
  samsara.getDriversNearLimit.definition,
  samsara.getVehicleStatus.definition,
  samsara.checkAssignmentCompliance.definition,
  cfr.searchCfr.definition,
  cfr.getCfrSection.definition,
  sms.queryBasicsStatus.definition,
  sms.queryTopViolations.definition,
  sms.queryDriverInspections.definition,
  sms.queryDataQsCandidates.definition,
  audit.logDecision.definition,
  audit.logRefusedRequest.definition,
  audit.logOffTopic.definition,
  escalate.escalateToCompliance.definition,
];

async function executeTool(name, input, context) {
  const tool = TOOLS[name];
  if (!tool) {
    return { error: `Herramienta desconocida: ${name}` };
  }
  return await tool.handler(input, context);
}

module.exports = { TOOL_DEFINITIONS, executeTool };
