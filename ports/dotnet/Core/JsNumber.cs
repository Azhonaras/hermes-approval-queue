using System.Globalization;

namespace HermesApproval.Core;

/// <summary>Number text as JavaScript's JSON.stringify prints it, so size limits count the same characters on every stack.</summary>
public static class JsNumber
{
    public const long MaxSafeInteger = 9007199254740991;

    public static string Text(double value)
    {
        if (value == 0) return "0";
        var sign = value < 0 ? "-" : "";
        value = Math.Abs(value);

        // Shortest digits that round-trip.
        var repr = "";
        for (var precision = 0; precision <= 16; precision++)
        {
            repr = value.ToString("E" + precision, CultureInfo.InvariantCulture);
            if (double.Parse(repr, CultureInfo.InvariantCulture) == value) break;
        }
        var parts = repr.Split('E');
        var digits = parts[0].Replace(".", "").TrimEnd('0');
        if (digits.Length == 0) digits = "0";
        var k = digits.Length;
        var n = int.Parse(parts[1], CultureInfo.InvariantCulture) + 1;

        string text;
        if (k <= n && n <= 21) text = digits + new string('0', n - k);
        else if (0 < n && n <= 21) text = digits[..n] + "." + digits[n..];
        else if (-6 < n && n <= 0) text = "0." + new string('0', -n) + digits;
        else
        {
            var e = n - 1;
            text = (k == 1 ? digits : digits[0] + "." + digits[1..]) + "e" + (e < 0 ? "-" : "+") + Math.Abs(e);
        }
        return sign + text;
    }
}
