from .extension import NotebookIntelligenceExtension, Host, ChatParticipant, ChatRequest, ChatResponse, Tool, ToolResponse

class TestChatParticipant(ChatParticipant):
    @property
    def id(self) -> str:
        return "test-participant"

    @property
    def name(self) -> str:
        return "Test Participant"

    def handle_chat_request(self, request: ChatRequest, response: ChatResponse) -> None:
        response.stream("Hello world!")

class TestTool(Tool):
    @property
    def id(self) -> str:
        return "test-tool"

    def handle_tool_call(self, request: ChatRequest) -> ToolResponse:
        return ToolResponse("Hello from tool!")

class TestInlineCompletionContextProvider:
    @property
    def id(self) -> str:
        return "test-inline-completion-context-provider"

    def handle_completion_context_request(self, request: ChatRequest, response: ChatResponse) -> None:
        response.stream("Hello from inline completion context provider!")

class TestExtension(NotebookIntelligenceExtension):
    def __init__(self):
        self.participant = TestChatParticipant()
        self.tool = TestTool()
        self.inline_completion_context_provider = TestInlineCompletionContextProvider()

    @property
    def id(self) -> str:
        return "test-extension"

    @property
    def name(self) -> str:
        return "Test Extension"

    def activate(self, host: Host) -> None:
        host.register_chat_participant(self.participant)
        host.register_tool(self.tool)
        host.register_inline_completion_context_provider(self.inline_completion_context_provider)
