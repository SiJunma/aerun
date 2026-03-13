# Command Execution Rule

To ensure reliability and transparency, the assistant should follow these guidelines when executing terminal commands:

1. **Ask for Permission**: Always ask the user to run terminal commands manually if they involve building, testing, or significant system changes.
2. **Provide the Exact Command**: Clearly state the exact command that the user should run.
3. **Wait for Results**: After the user runs the command, ask them to provide the output or confirm if it was successful before proceeding.
4. **Reasoning**: If the assistant believes it's better to run the command itself, it should first explain why and wait for explicit confirmation from the user.
