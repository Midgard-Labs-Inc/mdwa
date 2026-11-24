// Which unshielded output the wallet spends next when it balances a
// transaction: the SDK's balancer calls this while a token is short, with the
// token's imbalance (negative while inputs fall short of outputs), and adds
// the output returned as an input. The SDK's default takes the smallest output
// first, so it spends every small output before a large one that alone would
// do. This takes the smallest output that covers what is missing, and when no
// single output does, the largest, so a transaction has as few inputs as it
// can: one whenever one output is enough. Some transactions are only accepted
// while they stay small, with a single input.
export function fewestInputs(coins, tokenType, imbalance) {
  const missing = -imbalance;
  let covering, largest;
  for (const coin of coins) {
    if (coin.type !== tokenType) continue;
    if (coin.value >= missing && (!covering || coin.value < covering.value)) covering = coin;
    if (!largest || coin.value > largest.value) largest = coin;
  }
  return covering ?? largest;
}
