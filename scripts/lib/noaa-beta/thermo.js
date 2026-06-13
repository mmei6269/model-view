"use strict";

const { clamp } = require("./util");

const RD_OVER_CP = 0.2854;

const CP_OVER_RD = 1 / RD_OVER_CP;

const GRAVITY_M_S2 = 9.80665;

const EPSILON = 0.622;

const RD_DRY_AIR_J_KG_K = 287.05;

const CP_DRY_AIR_J_KG_K = 1004;

const LATENT_HEAT_VAPORIZATION_J_KG = 2.5e6;

const DRY_ADIABATIC_LAPSE_K_M = 0.0098;

const MOIST_ADIABATIC_MAX_STEP_M = 300;

const MOIST_LIFT_CONVERGENCE_C = 0.1;

function moistLiftTemperatureK(startPressureHpa, startTempK, targetPressureHpa) {
  const startPressure = Number(startPressureHpa);
  const targetPressure = Number(targetPressureHpa);
  const startTempC = kelvinToCelsius(startTempK);
  if (
    !Number.isFinite(startPressure) ||
    !Number.isFinite(targetPressure) ||
    !Number.isFinite(startTempC) ||
    startPressure <= 0 ||
    targetPressure <= 0
  ) {
    return Number.NaN;
  }
  const thetaC = potentialTemperatureC(startPressure, startTempC, 1000);
  const saturatedThetaC = thetaC - wobusCorrectionC(thetaC) + wobusCorrectionC(startTempC);
  const liftedC = saturatedLiftTemperatureC(targetPressure, saturatedThetaC);
  return Number.isFinite(liftedC) ? liftedC + 273.15 : Number.NaN;
}

function potentialTemperatureC(pressureHpa, tempC, referencePressureHpa = 1000) {
  const pressure = Number(pressureHpa);
  const referencePressure = Number(referencePressureHpa);
  const tempK = Number(tempC) + 273.15;
  if (!Number.isFinite(pressure) || !Number.isFinite(referencePressure) || !Number.isFinite(tempK) || pressure <= 0) {
    return Number.NaN;
  }
  return tempK * Math.pow(referencePressure / pressure, RD_OVER_CP) - 273.15;
}

function saturatedLiftTemperatureC(pressureHpa, saturatedThetaC) {
  const pressure = Number(pressureHpa);
  const theta = Number(saturatedThetaC);
  if (!Number.isFinite(pressure) || !Number.isFinite(theta) || pressure <= 0) {
    return Number.NaN;
  }
  if (Math.abs(pressure - 1000) <= 0.001) {
    return theta;
  }
  const pressurePower = Math.pow(pressure / 1000, RD_OVER_CP);
  let error = 999;
  let previousTemp = Number.NaN;
  let previousEval = Number.NaN;
  let temp = Number.NaN;
  let evalValue = Number.NaN;
  let rate;
  for (let iteration = 0; iteration < 80 && Math.abs(error) > MOIST_LIFT_CONVERGENCE_C; iteration += 1) {
    if (error === 999) {
      previousTemp = (theta + 273.15) * pressurePower - 273.15;
      previousEval = wobusCorrectionC(previousTemp) - wobusCorrectionC(theta);
      rate = 1;
    } else {
      const deltaEval = evalValue - previousEval;
      if (!Number.isFinite(deltaEval) || Math.abs(deltaEval) < 1e-9) {
        return Number.NaN;
      }
      rate = (temp - previousTemp) / deltaEval;
      previousTemp = temp;
      previousEval = evalValue;
    }
    temp = previousTemp - previousEval * rate;
    evalValue = (temp + 273.15) / pressurePower - 273.15;
    evalValue += wobusCorrectionC(temp) - wobusCorrectionC(evalValue) - theta;
    error = evalValue * rate;
  }
  return Number.isFinite(temp) && Number.isFinite(error) ? temp - error : Number.NaN;
}

function wobusCorrectionC(tempC) {
  const t = Number(tempC) - 20;
  if (!Number.isFinite(t)) {
    return Number.NaN;
  }
  if (t <= 0) {
    const polynomial =
      1 +
      t *
        (-8.841660499999999e-3 +
          t * (1.4714143e-4 + t * (-9.671989000000001e-7 + t * (-3.2607217e-8 + t * -3.8598073e-10))));
    return 15.13 / Math.pow(polynomial, 4);
  }
  let polynomial =
    t * (4.9618922e-7 + t * (-6.1059365e-9 + t * (3.9401551e-11 + t * (-1.2588129e-13 + t * 1.668828e-16))));
  polynomial = 1 + t * (3.6182989e-3 + t * (-1.3603273e-5 + polynomial));
  return 29.93 / Math.pow(polynomial, 4) + 0.96 * t - 14.8;
}

function integrateMoistParcelTemperatureK(startTempK, startHeightM, targetHeightM, pressureHpa) {
  if (
    !Number.isFinite(startTempK) ||
    !Number.isFinite(startHeightM) ||
    !Number.isFinite(targetHeightM) ||
    !Number.isFinite(pressureHpa)
  ) {
    return Number.NaN;
  }
  const dz = Math.max(0, targetHeightM - startHeightM);
  if (dz <= 0) {
    return startTempK;
  }
  const steps = Math.max(1, Math.ceil(dz / MOIST_ADIABATIC_MAX_STEP_M));
  const stepDz = dz / steps;
  const pressureUsable = pressureHpa > 0;
  let tempK = startTempK;
  for (let step = 0; step < steps; step += 1) {
    // Inlined moistAdiabaticLapseRateKPerM/saturationMixingRatioHpa with
    // identical operation order, guards, and NaN propagation.
    const tempC = tempK - 273.15;
    const vapor = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
    if (!pressureUsable || !Number.isFinite(vapor) || vapor <= 0 || vapor >= pressureHpa) {
      return Number.NaN;
    }
    const saturationMixingRatio = (EPSILON * vapor) / (pressureHpa - vapor);
    const latentTerm = (LATENT_HEAT_VAPORIZATION_J_KG * saturationMixingRatio) / (RD_DRY_AIR_J_KG_K * tempK);
    const denominator =
      CP_DRY_AIR_J_KG_K +
      (LATENT_HEAT_VAPORIZATION_J_KG * LATENT_HEAT_VAPORIZATION_J_KG * saturationMixingRatio * EPSILON) /
        (RD_DRY_AIR_J_KG_K * tempK * tempK);
    if (!Number.isFinite(latentTerm) || !Number.isFinite(denominator) || denominator <= 0) {
      return Number.NaN;
    }
    tempK -= ((GRAVITY_M_S2 * (1 + latentTerm)) / denominator) * stepDz;
  }
  return tempK;
}

function integrateMoistParcelDescentK(startTempK, startHeightM, targetHeightM, pressureHpa) {
  // Downward counterpart of integrateMoistParcelTemperatureK: a saturated
  // downdraft parcel kept at its wet-bulb state warms along the same
  // pseudoadiabatic lapse rate as it descends. Same fixed-step Euler scheme,
  // guards, and NaN propagation as the ascent integrator.
  if (
    !Number.isFinite(startTempK) ||
    !Number.isFinite(startHeightM) ||
    !Number.isFinite(targetHeightM) ||
    !Number.isFinite(pressureHpa)
  ) {
    return Number.NaN;
  }
  const dz = Math.max(0, startHeightM - targetHeightM);
  if (dz <= 0) {
    return startTempK;
  }
  const steps = Math.max(1, Math.ceil(dz / MOIST_ADIABATIC_MAX_STEP_M));
  const stepDz = dz / steps;
  const pressureUsable = pressureHpa > 0;
  let tempK = startTempK;
  for (let step = 0; step < steps; step += 1) {
    const tempC = tempK - 273.15;
    const vapor = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
    if (!pressureUsable || !Number.isFinite(vapor) || vapor <= 0 || vapor >= pressureHpa) {
      return Number.NaN;
    }
    const saturationMixingRatio = (EPSILON * vapor) / (pressureHpa - vapor);
    const latentTerm = (LATENT_HEAT_VAPORIZATION_J_KG * saturationMixingRatio) / (RD_DRY_AIR_J_KG_K * tempK);
    const denominator =
      CP_DRY_AIR_J_KG_K +
      (LATENT_HEAT_VAPORIZATION_J_KG * LATENT_HEAT_VAPORIZATION_J_KG * saturationMixingRatio * EPSILON) /
        (RD_DRY_AIR_J_KG_K * tempK * tempK);
    if (!Number.isFinite(latentTerm) || !Number.isFinite(denominator) || denominator <= 0) {
      return Number.NaN;
    }
    tempK += ((GRAVITY_M_S2 * (1 + latentTerm)) / denominator) * stepDz;
  }
  return tempK;
}

function moistAdiabaticLapseRateKPerM(tempK, pressureHpa) {
  const saturationMixingRatio = saturationMixingRatioHpa(tempK, pressureHpa);
  if (!Number.isFinite(tempK) || !Number.isFinite(saturationMixingRatio)) {
    return Number.NaN;
  }
  const latentTerm = (LATENT_HEAT_VAPORIZATION_J_KG * saturationMixingRatio) / (RD_DRY_AIR_J_KG_K * tempK);
  const denominator =
    CP_DRY_AIR_J_KG_K +
    (LATENT_HEAT_VAPORIZATION_J_KG * LATENT_HEAT_VAPORIZATION_J_KG * saturationMixingRatio * EPSILON) /
      (RD_DRY_AIR_J_KG_K * tempK * tempK);
  if (!Number.isFinite(latentTerm) || !Number.isFinite(denominator) || denominator <= 0) {
    return Number.NaN;
  }
  return (GRAVITY_M_S2 * (1 + latentTerm)) / denominator;
}

function mixingRatioFromDewpointK(dewpointK, pressureHpa) {
  return mixingRatioFromVaporPressureHpa(vaporPressureHpa(dewpointK), pressureHpa);
}

function saturationMixingRatioHpa(tempK, pressureHpa) {
  return mixingRatioFromVaporPressureHpa(vaporPressureHpa(tempK), pressureHpa);
}

function mixingRatioFromVaporPressureHpa(vaporPressure, pressureHpa) {
  const pressure = Number(pressureHpa);
  const e = Number(vaporPressure);
  if (!Number.isFinite(pressure) || !Number.isFinite(e) || pressure <= 0 || e <= 0 || e >= pressure) {
    return Number.NaN;
  }
  return (EPSILON * e) / (pressure - e);
}

function virtualTemperatureK(tempK, mixingRatio) {
  return Number.isFinite(tempK) && Number.isFinite(mixingRatio)
    ? (tempK * (1 + mixingRatio / EPSILON)) / (1 + mixingRatio)
    : Number.NaN;
}

function dewpointFromVaporPressureHpa(vaporPressure) {
  if (!Number.isFinite(vaporPressure) || vaporPressure <= 0) {
    return Number.NaN;
  }
  const logRatio = Math.log(vaporPressure / 6.112);
  return 273.15 + (243.5 * logRatio) / (17.67 - logRatio);
}

function dewpointFromTempRhK(tempK, rhPct) {
  if (!Number.isFinite(tempK) || !Number.isFinite(rhPct) || rhPct <= 0) {
    return Number.NaN;
  }
  const tempC = tempK - 273.15;
  const rh = clamp(Number(rhPct), 1, 100);
  const gamma = Math.log(rh / 100) + (17.625 * tempC) / (243.04 + tempC);
  return 273.15 + (243.04 * gamma) / (17.625 - gamma);
}

function boltonLclTemperatureK(tempK, dewpointK) {
  if (!Number.isFinite(tempK) || !Number.isFinite(dewpointK) || dewpointK <= 0) {
    return Number.NaN;
  }
  return 56 + 1 / (1 / (dewpointK - 56) + Math.log(tempK / dewpointK) / 800);
}

function boltonThetaE(tempK, dewpointK, pressureHpa) {
  const pressure = Number(pressureHpa);
  if (!Number.isFinite(tempK) || !Number.isFinite(dewpointK) || !Number.isFinite(pressure) || pressure <= 100) {
    return Number.NaN;
  }
  const e = vaporPressureHpa(dewpointK);
  if (!Number.isFinite(e) || e <= 0 || e >= pressure) {
    return Number.NaN;
  }
  const mixingRatio = (EPSILON * e) / (pressure - e);
  const lclTemp = boltonLclTemperatureK(tempK, dewpointK);
  if (!Number.isFinite(mixingRatio) || !Number.isFinite(lclTemp)) {
    return Number.NaN;
  }
  const dryTheta = tempK * Math.pow(1000 / (pressure - e), RD_OVER_CP * (1 - 0.28 * mixingRatio));
  return dryTheta * Math.exp((3376 / lclTemp - 2.54) * mixingRatio * (1 + 0.81 * mixingRatio));
}

function vaporPressureHpa(dewpointK) {
  if (!Number.isFinite(dewpointK)) {
    return Number.NaN;
  }
  const dewpointC = dewpointK - 273.15;
  return 6.112 * Math.exp((17.67 * dewpointC) / (dewpointC + 243.5));
}

function wetBulbTemperatureCAtPressure(tempK, dewpointK, pressureHpa) {
  const pressure = Number(pressureHpa);
  if (!Number.isFinite(tempK) || !Number.isFinite(dewpointK) || !Number.isFinite(pressure) || pressure <= 0) {
    return Number.NaN;
  }
  const cappedDewpointK = Math.min(dewpointK, tempK);
  const lclTempK = boltonLclTemperatureK(tempK, cappedDewpointK);
  if (!Number.isFinite(lclTempK)) {
    return Number.NaN;
  }
  const lclPressure = pressure * Math.pow(lclTempK / tempK, CP_OVER_RD);
  if (!Number.isFinite(lclPressure) || lclPressure <= 0) {
    return Number.NaN;
  }
  const wetBulbK = moistLiftTemperatureK(lclPressure, lclTempK, pressure);
  return Number.isFinite(wetBulbK) ? wetBulbK - 273.15 : Number.NaN;
}

function wetBulbTemperatureC(tempK, dewpointK) {
  if (!Number.isFinite(tempK) || !Number.isFinite(dewpointK)) {
    return Number.NaN;
  }
  const tempC = tempK - 273.15;
  const rh = relativeHumidityFromTempDewpoint(tempK, dewpointK);
  if (!Number.isFinite(rh)) {
    return Number.NaN;
  }
  return (
    tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tempC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035
  );
}

function relativeHumidityFromTempDewpoint(tempK, dewpointK) {
  const e = vaporPressureHpa(dewpointK);
  const es = vaporPressureHpa(tempK);
  return Number.isFinite(e) && Number.isFinite(es) && es > 0 ? clamp((100 * e) / es, 1, 100) : Number.NaN;
}

function kelvinToFahrenheit(value) {
  return Number.isFinite(value) ? ((value - 273.15) * 9) / 5 + 32 : Number.NaN;
}

function kelvinToCelsius(value) {
  return Number.isFinite(value) ? value - 273.15 : Number.NaN;
}

function pascalToHpa(value) {
  return Number.isFinite(value) ? value / 100 : Number.NaN;
}

module.exports = {
  CP_DRY_AIR_J_KG_K,
  CP_OVER_RD,
  DRY_ADIABATIC_LAPSE_K_M,
  EPSILON,
  GRAVITY_M_S2,
  LATENT_HEAT_VAPORIZATION_J_KG,
  MOIST_ADIABATIC_MAX_STEP_M,
  MOIST_LIFT_CONVERGENCE_C,
  RD_DRY_AIR_J_KG_K,
  RD_OVER_CP,
  boltonLclTemperatureK,
  boltonThetaE,
  dewpointFromTempRhK,
  dewpointFromVaporPressureHpa,
  integrateMoistParcelDescentK,
  integrateMoistParcelTemperatureK,
  kelvinToCelsius,
  kelvinToFahrenheit,
  mixingRatioFromDewpointK,
  mixingRatioFromVaporPressureHpa,
  moistAdiabaticLapseRateKPerM,
  moistLiftTemperatureK,
  pascalToHpa,
  potentialTemperatureC,
  relativeHumidityFromTempDewpoint,
  saturatedLiftTemperatureC,
  saturationMixingRatioHpa,
  vaporPressureHpa,
  virtualTemperatureK,
  wetBulbTemperatureC,
  wetBulbTemperatureCAtPressure,
  wobusCorrectionC,
};
