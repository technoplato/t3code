import type { UserInputQuestion } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  textInputProps: [] as Array<Record<string, unknown>>,
}));

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  View: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("expo-paste-input", () => ({
  TextInputWrapper: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppTextInput: (props: Record<string, unknown>) => {
    harness.textInputProps.push(props);
    return null;
  },
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: () => {} }));
vi.mock("../../components/ui/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/ui/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: () => null,
}));
vi.mock("./ComposerAttachmentButton", () => ({ ComposerAttachmentButton: () => null }));
vi.mock("../../lib/useNativePaste", () => ({ useNativePaste: () => () => {} }));
vi.mock("../../lib/composerImages", () => ({ convertPastedImagesToAttachments: async () => ({}) }));
vi.mock("../../i18n/messages", () => ({ m: {} }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => {} }) }));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "env-1", id: "thread-1" } }),
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => ({}) } }));
vi.mock("../../state/use-composer-drafts", () => ({
  appendComposerDraftAttachments: () => 0,
  composerDraftsAtom: {},
  removeComposerDraftAttachment: () => {},
}));
vi.mock("../../state/question-attachments", () => ({
  questionAttachmentDraftKey: (...parts: string[]) => parts.join(":"),
}));
vi.mock("../../state/question-attachment-preparation", () => ({
  pickQuestionAttachments: async () => ({ rejected: 0 }),
  startQuestionImagePreparation: () => ({ complete: async () => ({}), finish: () => {} }),
}));

import { QuestionAttachments } from "./QuestionAttachments";

it("wraps a custom answer across lines for a question without an initial answer", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.textInputProps = [];
  const question: UserInputQuestion = {
    id: "q1",
    header: "Question 1",
    question: "How should the branch be updated?",
    options: [{ label: "Rebase", value: "1", description: "Rebase" }],
  };
  expect(question.initialAnswer).toBeUndefined();

  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <QuestionAttachments
        requestId="request-1"
        question={question}
        questions={[question]}
        disabled={false}
        value=""
        onChangeText={() => {}}
      />,
    ),
  );

  const props = harness.textInputProps.at(-1);
  expect(props).toMatchObject({
    multiline: true,
    submitBehavior: "newline",
    textAlignVertical: "top",
  });
  expect(String(props?.className).split(" ")).toContain("max-h-36");

  act(() => root.unmount());
});
