import type { DeliveryStress } from "./types.ts";

const DECLINE_SCENARIOS = [50, 90, 100] as const;

export function stressDelivery(input: {
  principal: bigint;
  collateralValueAtEntry: bigint;
}): DeliveryStress[] {
  if (input.principal <= 0n) throw new RangeError("principal must be positive");
  if (input.collateralValueAtEntry < 0n) {
    throw new RangeError("collateral value must be non-negative");
  }

  return DECLINE_SCENARIOS.map((collateralDeclinePct) => {
    const stressedCollateralValue = (
      input.collateralValueAtEntry * BigInt(100 - collateralDeclinePct)
    ) / 100n;
    const estimatedRecovery = stressedCollateralValue < input.principal
      ? stressedCollateralValue
      : input.principal;
    const estimatedLoss = input.principal - estimatedRecovery;
    const lossBps = (estimatedLoss * 10_000n) / input.principal;

    return {
      collateralDeclinePct,
      estimatedRecovery,
      estimatedLoss,
      estimatedPrincipalLossPct: Number(lossBps) / 100,
    };
  });
}
