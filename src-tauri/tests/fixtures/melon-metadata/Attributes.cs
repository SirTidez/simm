using System;

namespace MelonLoader {
    [AttributeUsage(AttributeTargets.Assembly)]
    public class MelonInfoAttribute : Attribute {
        public MelonInfoAttribute(Type type, string name, string version, string author, string link = null) => throw new Exception("Metadata must never execute this constructor");
        public MelonInfoAttribute(Type type, string name, int major, int minor, int patch, string identifier, string author, string link = null) => throw new Exception("Metadata must never execute this constructor");
        public MelonInfoAttribute(Type type, string name, int major, int minor, int patch, string author, string link = null) => throw new Exception("Metadata must never execute this constructor");
    }
    [AttributeUsage(AttributeTargets.Assembly)]
    public class MelonPluginInfoAttribute : Attribute {
        public MelonPluginInfoAttribute(Type type, string name, string version, string author, string link = null) => throw new Exception("Metadata must never execute this constructor");
    }
}
namespace Unrelated {
    [AttributeUsage(AttributeTargets.Assembly)]
    public class MelonInfoAttribute : Attribute {
        public MelonInfoAttribute(Type type, string name, string version, string author) => throw new Exception("Unrelated attribute");
    }
}
