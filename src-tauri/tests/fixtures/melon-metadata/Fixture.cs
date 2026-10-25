using System;
using MelonLoader;

#if Modern
[assembly: MelonInfo(typeof(FixtureMod), "Fixture Ω", "2.7.1-beta.4+local", "Author Ω")]
#elif Numeric
[assembly: MelonInfo(typeof(FixtureMod), "Numeric fixture", 2, 3, 4, identifier: "rc.2", author: "Numeric author")]
#elif NumericStable
[assembly: MelonInfo(typeof(FixtureMod), "Stable fixture", 3, 4, 5, "Stable author")]
#elif Legacy
[assembly: MelonPluginInfo(typeof(FixtureMod), "Legacy plugin", "1.8.2", "Plugin author")]
#elif Fallback
[assembly: Unrelated.MelonInfo(typeof(FixtureMod), "Wrong namespace", "99.99.99", "Wrong author")]
#endif

public class FixtureMod { public const string DecoyVersion = "88.77.66.55"; }
