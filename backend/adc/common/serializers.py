from rest_framework import serializers


class ID(serializers.IntegerField):
    def __init__(self, **kwargs):
        super().__init__(min_value=1, max_value=2**63 - 1, **kwargs)


def values(serializer, payload, **kwargs):
    parser = serializer(data=payload, **kwargs)
    parser.is_valid(raise_exception=True)
    return dict(parser.validated_data)
