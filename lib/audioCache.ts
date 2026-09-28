export function prepareDeviceAudio(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve();
  const ready = navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready);
  const controlled = new Promise<void>((resolve) => {
    if (navigator.serviceWorker.controller) {
      resolve();
      return;
    }
    navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
  });
  return Promise.race([
    ready.then(() => controlled),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, 4000);
    }),
  ]);
}

export function retainDeviceAudio(urls: string[]) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const post = () => navigator.serviceWorker.controller?.postMessage({ type: "retain-audio", urls });
  post();
  void navigator.serviceWorker.ready.then(post).catch(() => undefined);
}
