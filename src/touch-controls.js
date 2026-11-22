export function touchControls(stage, { enabled, position, seek, pause, toggle, tapEnabled, scrub }) {
  let gesture;
  stage.addEventListener('pointerdown', event => {
    if (!enabled() || event.target.closest('button, a, input, select') || !event.isPrimary || event.button !== 0) return;
    gesture = { id: event.pointerId, y: event.clientY, position: position(), moved: false };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const distance = event.clientY - gesture.y;
    if (!gesture.moved && Math.abs(distance) < 7) return;
    if (!gesture.moved) pause();
    gesture.moved = true;
    event.preventDefault();
    seek(scrub(distance, gesture.position));
  });
  stage.addEventListener('pointerup', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const { moved } = gesture;
    gesture = null;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (!moved && tapEnabled()) toggle();
  });
  for (const name of ['pointercancel', 'lostpointercapture']) stage.addEventListener(name, () => { gesture = null; });
}
