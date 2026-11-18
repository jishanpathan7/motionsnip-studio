// The player half of the example add-on: a header button that asks the server half about the project.
export default function start(host) {
  host.addHeaderButton({
    label: 'Hello',
    title: 'Ask the Hello add-on about this project',
    onClick: async () => {
      const info = await host.api('info');
      const what = host.store.reel ? `"${host.store.reel.title}"` : 'this project';
      host.toast(`Hello from an add-on: ${what} is in ${info.project}, with ${info.files} file${info.files === 1 ? '' : 's'}.`);
    },
  });
}
