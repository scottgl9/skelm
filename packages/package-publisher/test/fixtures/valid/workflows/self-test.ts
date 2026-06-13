// A passing self-test: default-exports a function that returns normally.
export default function selfTest(): void {
  const sum = 2 + 2
  if (sum !== 4) throw new Error('math is broken')
}
