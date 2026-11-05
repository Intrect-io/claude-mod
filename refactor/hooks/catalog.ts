// The smell and technique taxonomy of refactoring.guru (https://refactoring.guru/refactoring),
// by name and canonical URL only. Every one-line description here is our own
// wording: the site's text is copyrighted and is not reproduced.

export const SITE = 'https://refactoring.guru'

export type TechniqueGroup =
  | 'Composing Methods'
  | 'Moving Features between Objects'
  | 'Organizing Data'
  | 'Simplifying Conditional Expressions'
  | 'Simplifying Method Calls'
  | 'Dealing with Generalization'

export type SmellGroup = 'Bloaters' | 'Object-Orientation Abusers' | 'Change Preventers' | 'Dispensables' | 'Couplers'

export type Technique = { name: string; group: TechniqueGroup; oneLine: string }
export type Smell = { name: string; group: SmellGroup; oneLine: string; techniques: string[] }

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export const techniqueUrl = (name: string) => `${SITE}/${slug(name)}`
export const smellUrl = (name: string) => `${SITE}/smells/${slug(name)}`

const t = (group: TechniqueGroup, entries: Array<[string, string]>): Technique[] => entries.map(([name, oneLine]) => ({ name, group, oneLine }))

export const TECHNIQUES: Technique[] = [
  ...t('Composing Methods', [
    ['Extract Method', 'Give a named function to a fragment that does one thing.'],
    ['Inline Method', 'Fold a function whose body says as much as its name back into its callers.'],
    ['Extract Variable', 'Name a hard-to-read subexpression with a local.'],
    ['Inline Temp', 'Drop a local that only holds a simple expression.'],
    ['Replace Temp with Query', 'Turn a computed local into a function other code can call too.'],
    ['Split Temporary Variable', 'One local per meaning, not one reused for several.'],
    ['Remove Assignments to Parameters', 'Assign to a fresh local instead of a parameter.'],
    ['Replace Method with Method Object', 'Move a long function with tangled locals into its own class whose fields are the locals.'],
    ['Substitute Algorithm', 'Swap a convoluted body for a clearer algorithm with the same result.'],
  ]),
  ...t('Moving Features between Objects', [
    ['Move Method', 'Put a function in the module or class whose data it uses most.'],
    ['Move Field', 'Put a field next to the code that reads it most.'],
    ['Extract Class', 'Split off the part of a class that has its own reason to change.'],
    ['Inline Class', 'Merge a class that does too little into its only user.'],
    ['Hide Delegate', 'Give the client one call instead of a walk through an object chain.'],
    ['Remove Middle Man', 'Let clients call the real object when a class only forwards.'],
    ['Introduce Foreign Method', 'Add a helper in the client for a library class you cannot change.'],
    ['Introduce Local Extension', 'Wrap or subclass a library class to hold the helpers it lacks.'],
  ]),
  ...t('Organizing Data', [
    ['Self Encapsulate Field', 'Read and write a field through accessors, even inside its class.'],
    ['Replace Data Value with Object', 'Promote a primitive with behavior to its own type.'],
    ['Change Value to Reference', 'Share one instance instead of many equal copies.'],
    ['Change Reference to Value', 'Make a small shared object an immutable value.'],
    ['Replace Array with Object', 'Use named fields instead of positions in an array.'],
    ['Duplicate Observed Data', 'Keep domain data out of the UI and sync it through observation.'],
    ['Change Unidirectional Association to Bidirectional', 'Add the back reference both sides need.'],
    ['Change Bidirectional Association to Unidirectional', 'Drop a back reference nobody needs.'],
    ['Replace Magic Number with Symbolic Constant', 'Name a literal whose meaning is not obvious.'],
    ['Encapsulate Field', 'Make a public field private behind accessors.'],
    ['Encapsulate Collection', 'Return a read-only view and offer add/remove methods.'],
    ['Replace Type Code with Class', 'Use a dedicated type instead of a coded number or string.'],
    ['Replace Type Code with Subclasses', 'One subclass per type code that changes behavior.'],
    ['Replace Type Code with State/Strategy', 'Move type-dependent behavior into swappable objects.'],
    ['Replace Subclass with Fields', 'Collapse subclasses that differ only in constants.'],
  ]),
  ...t('Simplifying Conditional Expressions', [
    ['Decompose Conditional', 'Name the condition and each branch as functions.'],
    ['Consolidate Conditional Expression', 'Merge conditions that lead to the same result.'],
    ['Consolidate Duplicate Conditional Fragments', 'Move code every branch runs out of the branches.'],
    ['Remove Control Flag', 'Use break, continue or return instead of a flag variable.'],
    ['Replace Nested Conditional with Guard Clauses', 'Return early for special cases so the main path stays flat.'],
    ['Replace Conditional with Polymorphism', 'Let each type implement the branch that belongs to it.'],
    ['Introduce Null Object', 'Return an object with default behavior instead of null checks everywhere.'],
    ['Introduce Assertion', 'State an assumption the code relies on as an assertion.'],
  ]),
  ...t('Simplifying Method Calls', [
    ['Rename Method', 'Make the name say what the function does.'],
    ['Add Parameter', 'Pass the data a function needs instead of reaching for it.'],
    ['Remove Parameter', 'Drop a parameter the body no longer uses.'],
    ['Separate Query from Modifier', 'One function returns a value, another changes state.'],
    ['Parameterize Method', 'Merge near-identical functions into one with a parameter.'],
    ['Replace Parameter with Explicit Methods', 'One function per value of a mode parameter.'],
    ['Preserve Whole Object', 'Pass the object instead of several of its fields.'],
    ['Replace Parameter with Method Call', 'Let the callee compute a value it can get itself.'],
    ['Introduce Parameter Object', 'Group parameters that always travel together into one type.'],
    ['Remove Setting Method', 'Set a field once at construction instead of through a setter.'],
    ['Hide Method', 'Make a function private when only its own module calls it.'],
    ['Replace Constructor with Factory Method', 'Construct through a named function that can choose the type.'],
    ['Replace Error Code with Exception', 'Signal failure by raising instead of returning a code.'],
    ['Replace Exception with Test', 'Check the condition first instead of catching an expected error.'],
  ]),
  ...t('Dealing with Generalization', [
    ['Pull Up Field', 'Move a field every subclass has into the parent.'],
    ['Pull Up Method', 'Move identical subclass methods into the parent.'],
    ['Pull Up Constructor Body', 'Move shared constructor code into the parent constructor.'],
    ['Push Down Method', 'Move a parent method only one subclass uses down into it.'],
    ['Push Down Field', 'Move a parent field only one subclass uses down into it.'],
    ['Extract Subclass', 'Split rarely used features into a subclass.'],
    ['Extract Superclass', 'Give two classes with shared features a common parent.'],
    ['Extract Interface', 'Declare the part of a class clients rely on as an interface, so they depend on it instead.'],
    ['Collapse Hierarchy', 'Merge a subclass that is barely different from its parent.'],
    ['Form Template Method', 'Keep the shared algorithm in the parent, the differing steps in subclasses.'],
    ['Replace Inheritance with Delegation', 'Hold the would-be parent as a field when only part of it is used.'],
    ['Replace Delegation with Inheritance', 'Inherit when a class forwards every call to one delegate.'],
  ]),
]

const s = (group: SmellGroup, entries: Array<[string, string, string[]]>): Smell[] => entries.map(([name, oneLine, techniques]) => ({ name, group, oneLine, techniques }))

export const SMELLS: Smell[] = [
  ...s('Bloaters', [
    ['Long Method', 'A function long enough that you have to scroll or comment sections of it.', ['Extract Method', 'Replace Temp with Query', 'Introduce Parameter Object', 'Replace Method with Method Object', 'Decompose Conditional']],
    ['Large Class', 'A class or module with too many fields, methods or lines to keep in your head.', ['Extract Class', 'Extract Subclass', 'Extract Interface', 'Duplicate Observed Data']],
    ['Primitive Obsession', 'Strings, numbers and arrays standing in for domain concepts.', ['Replace Data Value with Object', 'Introduce Parameter Object', 'Replace Type Code with Class', 'Replace Array with Object']],
    ['Long Parameter List', 'More parameters than a caller can pass correctly without looking.', ['Introduce Parameter Object', 'Preserve Whole Object', 'Replace Parameter with Method Call']],
    ['Data Clumps', 'The same few values always passed or stored together.', ['Extract Class', 'Introduce Parameter Object', 'Preserve Whole Object']],
  ]),
  ...s('Object-Orientation Abusers', [
    ['Switch Statements', 'The same switch or if-chain on a type, repeated in several places.', ['Replace Conditional with Polymorphism', 'Replace Type Code with State/Strategy', 'Replace Parameter with Explicit Methods', 'Introduce Null Object']],
    ['Temporary Field', 'A field that only holds a value during one operation.', ['Extract Class', 'Introduce Null Object']],
    ['Refused Bequest', 'A subclass that uses little of what it inherits.', ['Replace Inheritance with Delegation', 'Extract Superclass']],
    ['Alternative Classes with Different Interfaces', 'Two classes that do the same thing under different method names.', ['Rename Method', 'Move Method', 'Extract Superclass']],
  ]),
  ...s('Change Preventers', [
    ['Divergent Change', 'One module edited for many unrelated reasons.', ['Extract Class', 'Extract Superclass', 'Extract Subclass']],
    ['Shotgun Surgery', 'One change that needs small edits in many modules.', ['Move Method', 'Move Field', 'Inline Class']],
    ['Parallel Inheritance Hierarchies', 'Adding a subclass in one hierarchy forces one in another.', ['Move Method', 'Move Field']],
  ]),
  ...s('Dispensables', [
    ['Comments', 'A comment that explains what unclear code does instead of the code being clear.', ['Extract Variable', 'Extract Method', 'Rename Method', 'Introduce Assertion']],
    ['Duplicate Code', 'The same or nearly the same code in more than one place.', ['Extract Method', 'Pull Up Method', 'Form Template Method', 'Substitute Algorithm', 'Consolidate Duplicate Conditional Fragments']],
    ['Lazy Class', 'A class that does too little to justify itself.', ['Inline Class', 'Collapse Hierarchy']],
    ['Data Class', 'A class with fields and accessors but no behavior of its own.', ['Encapsulate Field', 'Encapsulate Collection', 'Move Method', 'Remove Setting Method', 'Hide Method']],
    ['Dead Code', 'Variables, parameters, branches or functions nothing uses.', ['Remove Parameter', 'Inline Class', 'Collapse Hierarchy']],
    ['Speculative Generality', 'Hooks, parameters and abstractions for needs that never came.', ['Collapse Hierarchy', 'Inline Class', 'Inline Method', 'Remove Parameter']],
  ]),
  ...s('Couplers', [
    ['Feature Envy', 'A function that uses another module\'s data more than its own.', ['Move Method', 'Extract Method']],
    ['Inappropriate Intimacy', 'Two modules reaching into each other\'s internals.', ['Move Method', 'Move Field', 'Change Bidirectional Association to Unidirectional', 'Replace Delegation with Inheritance', 'Hide Delegate']],
    ['Message Chains', 'a.b().c().d(): the client depends on the whole path.', ['Hide Delegate', 'Extract Method', 'Move Method']],
    ['Middle Man', 'A class that only forwards calls to another.', ['Remove Middle Man']],
    ['Incomplete Library Class', 'A library that lacks a method you need and cannot be changed.', ['Introduce Foreign Method', 'Introduce Local Extension']],
  ]),
]

export function findTechnique(name: string): Technique | undefined {
  return TECHNIQUES.find(technique => technique.name.toLowerCase() === name.toLowerCase())
}

export function findSmell(query: string): Smell | undefined {
  const q = slug(query)

  return SMELLS.find(smell => slug(smell.name) === q) ?? SMELLS.find(smell => slug(smell.name).includes(q))
}

/** One smell as note text: its name, URL and the first techniques, each with its URL. */
export function smellAdvice(name: string, count = 2): string {
  const smell = findSmell(name)
  if (smell === undefined) return name
  const fixes = smell.techniques.slice(0, count).map(technique => `${technique} (${techniqueUrl(technique)})`)

  return `${smell.name} (${smellUrl(smell.name)}) → ${fixes.join(', ')}`
}

/** The catalog as Markdown, for /arch catalog. A query narrows it to one smell or technique. */
export function renderCatalog(query = ''): string {
  if (query.trim() !== '') {
    const smell = findSmell(query)
    if (smell !== undefined) {
      return [
        `**${smell.name}** (${smell.group}) — ${smell.oneLine}`,
        smellUrl(smell.name),
        '',
        ...smell.techniques.map(name => `- ${name}: ${findTechnique(name)?.oneLine ?? ''} ${techniqueUrl(name)}`),
      ].join('\n')
    }
    const q = slug(query)
    const technique = TECHNIQUES.find(entry => slug(entry.name) === q) ?? TECHNIQUES.find(entry => slug(entry.name).includes(q))
    if (technique !== undefined) {
      const curing = SMELLS.filter(entry => entry.techniques.includes(technique.name)).map(entry => entry.name)

      return [`**${technique.name}** (${technique.group}) — ${technique.oneLine}`, techniqueUrl(technique.name), '', `Cures: ${curing.join(', ') || '—'}`].join('\n')
    }

    return `No smell or technique matches "${query}". /arch catalog lists them all.`
  }
  const lines = ['# Code smells → refactorings', `Taxonomy: ${SITE}/refactoring (names and links only; descriptions are our own).`, '']
  let group = ''
  for (const smell of SMELLS) {
    if (smell.group !== group) {
      group = smell.group
      lines.push(`## ${group}`)
    }
    lines.push(`- **${smell.name}** — ${smell.oneLine} → ${smell.techniques.join(', ')}`)
  }

  return lines.join('\n')
}
