/**
 * Vue 3 binding: `import { Wraith } from 'wraithterm/vue'`.
 * Built with `defineComponent` and `h`, so no SFC compiler is required.
 */
import {
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type App,
  type PropType,
} from 'vue';
import {
  WraithController,
  remountKey,
  type WraithBindingConfig,
  type WraithEvents,
  type WraithInstance,
  type WraithProfile,
  type XtermOptions,
} from './binding.js';
import type { WraithOptions } from './types.js';
export type {
  WraithEvents,
  WraithInstance,
  WraithProfile,
  XtermOptions,
  WraithBindingConfig,
} from './binding.js';
export { WraithDisposedError } from './binding.js';

/** What a template ref on `<Wraith>` exposes. */
export interface WraithExposed {
  /** The mounted terminal; null until ready. */
  readonly terminal: WraithInstance | null;
  readonly ready: Promise<WraithInstance>;
  write(data: string | Uint8Array): Promise<void>;
  focus(): void;
}

/**
 * `<Wraith :options="{ fontSize: 14 }" src="ws://…" @data="…" @title-change="…" />`
 *
 * Events: `ready`, `data`, `bytes`, `title-change`, `bell`, `resize`, `error`.
 * Theme, font size, line height and (with `fit: false`) grid size update live;
 * a `profile` change remounts.
 */
export const Wraith = defineComponent({
  name: 'WraithTerminal',
  props: {
    profile: { type: String as PropType<WraithProfile>, default: 'native' },
    options: { type: Object as PropType<WraithOptions | XtermOptions>, default: undefined },
    src: { type: [String, Object] as PropType<string | URL | WebSocket | null>, default: null },
    autoFocus: { type: Boolean, default: false },
  },
  emits: {
    ready: (_terminal: WraithInstance) => true,
    data: (_data: string) => true,
    bytes: (_bytes: Uint8Array) => true,
    titleChange: (_title: string) => true,
    bell: () => true,
    resize: (_size: { cols: number; rows: number }) => true,
    error: (_error: Error) => true,
  },
  setup(props, { emit, expose }) {
    const host = ref<HTMLDivElement>();
    const controller = shallowRef<WraithController | null>(null);
    const events: WraithEvents = {
      onReady: (terminal) => emit('ready', terminal),
      onData: (data) => emit('data', data),
      onBytes: (bytes) => emit('bytes', bytes),
      onTitleChange: (title) => emit('titleChange', title),
      onBell: () => emit('bell'),
      onResize: (size) => emit('resize', size),
      onError: (error) => emit('error', error),
    };
    const config = (): WraithBindingConfig =>
      ({
        profile: props.profile,
        options: props.options,
        src: props.src,
        autoFocus: props.autoFocus,
      }) as WraithBindingConfig;
    const start = () => {
      if (host.value) controller.value = new WraithController(host.value, config(), events);
    };
    const stop = () => {
      const current = controller.value;
      controller.value = null;
      void current?.dispose();
    };
    onMounted(start);
    onBeforeUnmount(stop);
    watch(
      () => remountKey(config()),
      () => {
        stop();
        start();
      },
    );
    watch(
      () => [props.options, props.src, props.autoFocus],
      () => void controller.value?.update(config()).catch(() => {}),
      { deep: true },
    );
    const exposed: WraithExposed = {
      get terminal() {
        return controller.value?.terminal ?? null;
      },
      get ready() {
        return controller.value?.ready ?? Promise.reject(new Error('Wraith is not mounted'));
      },
      write: (data) =>
        controller.value
          ? controller.value.write(data)
          : Promise.reject(new Error('Wraith is not mounted')),
      focus: () => controller.value?.focus(),
    };
    expose(exposed);
    return () =>
      h('div', {
        ref: host,
        class: 'wraith-host',
        'data-wraith-profile': props.profile,
        style: { width: '100%', height: '100%' },
      });
  },
});
export const WraithTerminal = Wraith;

/** `app.use(WraithPlugin)` registers `<Wraith>` and `<WraithTerminal>` globally. */
export const WraithPlugin = {
  install(app: App) {
    app.component('Wraith', Wraith);
    app.component('WraithTerminal', Wraith);
  },
};
export default WraithPlugin;
