// Runs a generator in slices of about `budget` ms, handing control back to the
// browser in between so it can paint and handle input. Every `yield` in the
// generator is a point where it may pause. The first slice waits for the next
// paint, so whatever the caller just put on screen (a loading state) shows
// first. Resolves with the generator's return value; rejects (and closes the
// generator) once `signal` aborts.
export function runSliced(steps, { signal, budget = 12 } = {}) {
  return new Promise((resolve, reject) => {
    const slice = () => {
      if (signal?.aborted) {
        steps.return()
        reject(signal.reason)
        return
      }
      const end = performance.now() + budget
      try {
        for (;;) {
          const { done, value } = steps.next()
          if (done) {
            resolve(value)
            return
          }
          if (performance.now() >= end) break
        }
      } catch (err) {
        reject(err)
        return
      }
      setTimeout(slice)
    }
    requestAnimationFrame(() => setTimeout(slice))
  })
}
