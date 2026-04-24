import { MaterialStudioProvider, useAppState } from "./state/context";
import { LibraryView } from "./views/LibraryView";
import { BaseMeshPickerView } from "./views/BaseMeshPickerView";
import { AuthoringView } from "./views/AuthoringView";
import { Toasts } from "./components/Toasts";

function ViewSwitcher() {
  const { view } = useAppState();
  switch (view.kind) {
    case "library":
      return <LibraryView />;
    case "base-picker":
      return <BaseMeshPickerView />;
    case "authoring":
      return <AuthoringView />;
  }
}

export function App() {
  return (
    <MaterialStudioProvider>
      <div className="matstudio-app">
        <ViewSwitcher />
        <Toasts />
      </div>
    </MaterialStudioProvider>
  );
}
