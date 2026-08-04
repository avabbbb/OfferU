import { lazy, Suspense, type ComponentType } from "react";

interface DynamicOptions {
  loading?: ComponentType;
  ssr?: boolean;
}

export default function dynamic(
  loader: () => Promise<{ default: ComponentType<any> }>,
  options: DynamicOptions = {},
) {
  const LazyComponent = lazy(loader);
  const Loading = options.loading;
  return function DynamicComponent(props: Record<string, unknown>) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}
