// Node's test reporter protocol is available in Node 20.
export default async function* reporter(source) {
  for await (const event of source) {
    if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.nesting === 0 && event.data.name !== event.data.file) {
      yield JSON.stringify(event) + '\n';
    }
  }
}
